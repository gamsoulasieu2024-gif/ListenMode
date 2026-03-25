import {
  payloadToContextText,
  urlLooksLikePdf,
  probePdfContentType
} from "../utils/extractor.js";
import { generateListenScript, generateUnderstandScript } from "../utils/ai.js";
import { streamListenScript } from "../utils/ai.js";

/**
 * Gemini HTTP calls are implemented in ../utils/ai.js (safetySettings, generationConfig,
 * augmented prompts, empty-response handling). This worker only routes LISTENMODE_GENERATE_AI.
 */

/** Minimum extracted characters before calling the model */
const MIN_CONTENT_CHARS = 100;

/** @type {(() => void) | null} */
let offscreenReadyResolve = null;

/** @type {number | null} */
let playbackTabId = null;
/** @type {string} */
let playbackUrl = "";
/** @type {string} */
let pageTitleForMini = "";
let lastPercentage = 0;
let lastPaused = false;
/** True after a successful LISTENMODE_PLAY until end / error / stop. */
let sessionActive = false;
/** @type {AbortController | null} */
let streamAbort = null;

// --- MV3 keep-alive (session-scoped) ---
/** @type {ReturnType<typeof setInterval> | null} */
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

/**
 * Popup opens when the user clicks the toolbar icon — configured via
 * manifest "action.default_popup". MV3 does not use a persistent background page;
 * this service worker starts for events and sleeps when idle.
 */

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/**
 * Heuristic PDF tab: .pdf URL, Chrome built-in viewer extension, or Content-Type.
 * @param {{ url?: string } | undefined} tab
 * @returns {Promise<boolean>}
 */
async function resolveIsPdfTab(tab) {
  const url = tab?.url || "";
  if (urlLooksLikePdf(url)) return true;
  if (/mhjfbmdgcfjbbpaeojofohoefgiehjai/i.test(url)) return true;
  return probePdfContentType(url);
}

/**
 * Injects the content script on user action (popup Start), then extracts text.
 * @param {number} tabId
 * @returns {Promise<{ text: string }>}
 */
async function extractFromTab(tabId) {
  if (tabId == null) throw new Error("No active tab.");

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/content.js"]
  });

  const res = await chrome.tabs.sendMessage(tabId, { action: "extractContent" });
  if (!res?.success) {
    throw new Error(res?.error || "Extraction failed.");
  }
  return { text: res.content };
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  const ready = new Promise((resolve) => {
    offscreenReadyResolve = resolve;
  });
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL("offscreen/offscreen.html"),
    reasons: ["AUDIO_PLAYBACK", "DOM_PARSER"],
    justification: "Offscreen audio playback and PDF text extraction"
  });
  await Promise.race([ready, new Promise((r) => setTimeout(r, 4000))]);
}

async function closeOffscreenDocument() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {Record<string, unknown>} msg
 * @returns {Promise<Record<string, unknown>>}
 */
function sendToOffscreen(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(r && typeof r === "object" ? r : { ok: true });
      }
    });
  });
}

/**
 * Parse PDF bytes in the offscreen document to avoid PDF.js eval() usage in the service worker.
 * @param {string} pdfUrl
 * @returns {Promise<{ ok: boolean, success?: boolean, text?: string, pageCount?: number, error?: string }>}
 */
async function parsePDFInOffscreen(pdfUrl) {
  const result = await chrome.runtime.sendMessage({
    action: "fetchURL",
    url: pdfUrl
  });
  if (!result?.success) {
    return { ok: false, success: false, error: String(result?.error || "Fetch failed") };
  }

  await ensureOffscreen();
  return /** @type {any} */ (
    await sendToOffscreen({
      type: "LISTENMODE_PARSE_PDF",
      data: Array.isArray(result.data) ? result.data : []
    })
  );
}

/**
 * @param {number | null | undefined} tabId
 * @param {Record<string, unknown>} payload
 */
function notifyMini(tabId, payload) {
  if (tabId == null) return;
  void chrome.tabs.sendMessage(tabId, { type: "LISTENMODE_MINI", ...payload }).catch(() => {});
}

/**
 * @param {{ event: string, detail?: Record<string, unknown>, tabId?: number | null }} message
 */
function handleAudioEventFromOffscreen(message) {
  const { event, detail, tabId } = message;
  const tid = tabId ?? playbackTabId;

  void chrome.runtime
    .sendMessage({
      type: "LISTENMODE_AUDIO_EVENT",
      event,
      detail: detail || {},
      tabId: tid
    })
    .catch(() => {});

  if (event === "progress" && detail) {
    const raw = /** @type {{ percentage?: number; percent?: number }} */ (detail);
    const pct =
      raw.percentage != null
        ? raw.percentage
        : raw.percent != null
          ? raw.percent
          : lastPercentage;
    lastPercentage = Math.min(100, Math.max(0, Number(pct) || 0));
  }
  if (event === "pause") lastPaused = true;
  if (event === "resume") lastPaused = false;

  if (event === "start") {
    sessionActive = true;
    lastPaused = false;
    lastPercentage = 0;
    notifyMini(tid, { action: "show", title: pageTitleForMini });
    notifyMini(tid, { action: "state", progress: 0, paused: false, playing: true });
  } else if (event === "progress") {
    notifyMini(tid, {
      action: "state",
      progress: lastPercentage,
      paused: lastPaused,
      playing: true
    });
  } else if (event === "pause") {
    notifyMini(tid, {
      action: "state",
      progress: lastPercentage,
      paused: true,
      playing: true
    });
  } else if (event === "resume") {
    notifyMini(tid, {
      action: "state",
      progress: lastPercentage,
      paused: false,
      playing: true
    });
  } else if (event === "end") {
    sessionActive = false;
    notifyMini(tid, { action: "ending" });
    playbackTabId = null;
    playbackUrl = "";
    pageTitleForMini = "";
    void closeOffscreenDocument();
  } else if (event === "playback-error") {
    sessionActive = false;
    notifyMini(tid, { action: "remove" });
    playbackTabId = null;
    playbackUrl = "";
    pageTitleForMini = "";
    void closeOffscreenDocument();
  }
}

/**
 * @param {number} tabId
 */
async function stopPlaybackFromNavigation(tabId) {
  if (playbackTabId !== tabId) return;
  await ensureOffscreen();
  await sendToOffscreen({ type: "LISTENMODE_OFFSCREEN_CMD", cmd: "stop" });
  sessionActive = false;
  notifyMini(tabId, { action: "remove" });
  playbackTabId = null;
  playbackUrl = "";
  pageTitleForMini = "";
  await closeOffscreenDocument();
  void chrome.runtime.sendMessage({ type: "LISTENMODE_PLAYBACK_STOPPED" }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (playbackTabId == null || tabId !== playbackTabId) return;
  const nextUrl = changeInfo.url || tab?.url || "";
  if (!nextUrl || nextUrl.startsWith("chrome://")) return;
  if (playbackUrl && nextUrl !== playbackUrl) {
    void stopPlaybackFromNavigation(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // External fetch proxy to avoid extension page CSP restrictions.
  // Content scripts / extension pages can request bytes via this handler.
  if (message?.action === "fetchURL") {
    (async () => {
      try {
        const url = String(message.url || "");
        if (!url) throw new Error("Missing url");
        const method = String(message.method || "GET").toUpperCase();

        const r = await fetch(url, { method, credentials: "include" });
        const contentType = r.headers.get("content-type") || "";

        if (method === "HEAD") {
          sendResponse({ success: true, status: r.status, contentType });
          return;
        }

        const buffer = await r.arrayBuffer();
        sendResponse({
          success: true,
          status: r.status,
          contentType,
          data: Array.from(new Uint8Array(buffer))
        });
      } catch (err) {
        sendResponse({ success: false, error: String(err?.message || err) });
      }
    })();
    return true; // keep channel open for async response
  }

  // Popup session keep-alive control (prevents MV3 cold starts mid-session).
  if (message?.action === "sessionStart") {
    startKeepAlive();
    sendResponse?.({ ok: true });
    return false;
  }
  if (message?.action === "sessionEnd") {
    stopKeepAlive();
    sendResponse?.({ ok: true });
    return false;
  }

  if (message?.type === "LISTENMODE_OFFSCREEN_READY") {
    offscreenReadyResolve?.();
    offscreenReadyResolve = null;
    return false;
  }

  if (message?.type === "LISTENMODE_AUDIO_EVENT") {
    handleAudioEventFromOffscreen(
      /** @type {{ event: string, detail?: Record<string, unknown>, tabId?: number | null }} */ (
        message
      )
    );
    return false;
  }

  (async () => {
    try {
      if (message?.type === "LISTENMODE_STREAM_LISTEN") {
        // Abort any previous stream session.
        try {
          streamAbort?.abort();
        } catch {
          /* ignore */
        }
        streamAbort = new AbortController();

        const ctx = String(message.context || "");
        const lang = String(message.lang || "en");
        const elevenKey = String(message.elevenApiKey || "").trim();
        const voiceId = String(message.voiceId || "").trim();
        const tabId = message.tabId != null ? Number(message.tabId) : null;
        const pageTitle = String(message.pageTitle || "");

        if (!ctx.trim()) {
          sendResponse({ ok: false, error: "Nothing to read.", retry: true });
          return;
        }
        if (!elevenKey || !voiceId) {
          sendResponse({ ok: false, error: "Missing ElevenLabs credentials.", retry: true });
          return;
        }

        await ensureOffscreen();
        playbackTabId = Number.isFinite(tabId) ? tabId : null;
        pageTitleForMini = pageTitle;
        lastPercentage = 0;
        lastPaused = false;
        sessionActive = true;

        // Initialize the offscreen streaming pipeline.
        await sendToOffscreen({
          type: "LISTENMODE_OFFSCREEN_STREAM_INIT",
          options: { tabId: playbackTabId }
        });

        sendResponse({ ok: true });

        // Start streaming Gemini sentences and enqueue ElevenLabs fetches immediately.
        let added = 0;
        try {
          for await (const sentence of streamListenScript(ctx, lang)) {
            if (streamAbort?.signal.aborted) break;
            const s = String(sentence || "").trim();
            if (s.length < 10) continue;
            added += 1;
            void chrome.runtime
              .sendMessage({
                type: "LISTENMODE_OFFSCREEN_STREAM_ADD",
                text: s,
                voiceId,
                apiKey: elevenKey
              })
              .catch(() => {});
          }
        } catch (e) {
          console.log("[ListenMode] streamListenScript failed:", e?.message || e, e);
          // Stop pipeline on failure so UI gets end event.
          try {
            await sendToOffscreen({ type: "LISTENMODE_OFFSCREEN_CMD", cmd: "stop" });
          } catch {
            /* ignore */
          }
          sessionActive = false;
          playbackTabId = null;
          playbackUrl = "";
          pageTitleForMini = "";
          void closeOffscreenDocument();
        }
        return;
      }

      if (message?.type === "LISTENMODE_PLAY") {
        const opt = message.options || {};
        const tid = opt.tabId != null ? Number(opt.tabId) : null;
        const playbackTabIdNum = Number.isFinite(tid) ? tid : null;
        if (playbackTabIdNum != null) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: playbackTabIdNum },
              files: ["content/content.js"]
            });
          } catch {
            /* page may not allow injection */
          }
        }
        await ensureOffscreen();
        playbackTabId = playbackTabIdNum;
        pageTitleForMini = String(message.pageTitle || "");
        lastPercentage = 0;
        lastPaused = false;
        if (playbackTabId != null) {
          try {
            const t = await chrome.tabs.get(playbackTabId);
            playbackUrl = t.url || "";
          } catch {
            playbackUrl = "";
          }
        } else {
          playbackUrl = "";
        }
        const r = await sendToOffscreen({
          type: "LISTENMODE_OFFSCREEN_PLAY",
          text: message.text,
          lang: message.lang,
          options: message.options
        });
        if (r && r.ok !== false) {
          sessionActive = true;
          sendResponse({ ok: true });
        } else {
          sessionActive = false;
          playbackTabId = null;
          playbackUrl = "";
          pageTitleForMini = "";
          sendResponse({
            ok: false,
            error: /** @type {{ error?: string }} */ (r)?.error || "Playback failed.",
            retry: true
          });
        }
        return;
      }

      if (message?.type === "LISTENMODE_AUDIO_CMD") {
        const cmd = message.cmd;
        if (cmd === "stop") {
          try {
            streamAbort?.abort();
          } catch {
            /* ignore */
          }
          streamAbort = null;
        }
        await ensureOffscreen();
        /** @type {{ type: string, cmd: string, seconds?: number, rate?: number }} */
        const payload = { type: "LISTENMODE_OFFSCREEN_CMD", cmd };
        if (cmd === "rewind") payload.seconds = message.seconds;
        if (cmd === "setSpeed") payload.rate = message.rate;
        await sendToOffscreen(payload);
        if (cmd === "stop") {
          sessionActive = false;
          notifyMini(playbackTabId, { action: "remove" });
          playbackTabId = null;
          playbackUrl = "";
          pageTitleForMini = "";
          await closeOffscreenDocument();
          void chrome.runtime.sendMessage({ type: "LISTENMODE_PLAYBACK_STOPPED" }).catch(() => {});
        }
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "LISTENMODE_MINI_CONTROL") {
        const cmd = message.cmd;
        const fromTab = sender.tab?.id;
        if (
          cmd === "pause" ||
          cmd === "resume" ||
          cmd === "stop" ||
          cmd === "rewind" ||
          cmd === "dismiss"
        ) {
          if (cmd === "dismiss") {
            await ensureOffscreen();
            await sendToOffscreen({ type: "LISTENMODE_OFFSCREEN_CMD", cmd: "stop" });
            sessionActive = false;
            notifyMini(fromTab ?? playbackTabId, { action: "remove" });
            playbackTabId = null;
            playbackUrl = "";
            pageTitleForMini = "";
            await closeOffscreenDocument();
            void chrome.runtime.sendMessage({ type: "LISTENMODE_PLAYBACK_STOPPED" }).catch(() => {});
            sendResponse({ ok: true });
            return;
          }
          await ensureOffscreen();
          /** @type {{ type: string, cmd: string, seconds?: number }} */
          const payload = { type: "LISTENMODE_OFFSCREEN_CMD", cmd };
          if (cmd === "rewind") payload.seconds = 5;
          await sendToOffscreen(payload);
          if (cmd === "stop") {
            sessionActive = false;
            notifyMini(fromTab ?? playbackTabId, { action: "remove" });
            playbackTabId = null;
            playbackUrl = "";
            pageTitleForMini = "";
            await closeOffscreenDocument();
            void chrome.runtime.sendMessage({ type: "LISTENMODE_PLAYBACK_STOPPED" }).catch(() => {});
          }
        }
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "LISTENMODE_CONTENT_UNLOAD") {
        const tid = sender.tab?.id;
        if (tid != null && tid === playbackTabId) {
          await ensureOffscreen();
          await sendToOffscreen({ type: "LISTENMODE_OFFSCREEN_CMD", cmd: "stop" });
          sessionActive = false;
          notifyMini(tid, { action: "remove" });
          playbackTabId = null;
          playbackUrl = "";
          pageTitleForMini = "";
          await closeOffscreenDocument();
          void chrome.runtime.sendMessage({ type: "LISTENMODE_PLAYBACK_STOPPED" }).catch(() => {});
        }
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "LISTENMODE_GET_PLAYBACK_STATE") {
        sendResponse({
          ok: true,
          playing: sessionActive,
          paused: lastPaused,
          percentage: lastPercentage
        });
        return;
      }

      if (message?.type === "LISTENMODE_GET_SOURCE_MODE") {
        const tabId = await getActiveTabId();
        if (tabId == null) {
          sendResponse({ ok: true, mode: "webpage" });
          return;
        }
        try {
          const tab = await chrome.tabs.get(tabId);
          const isPdf = await resolveIsPdfTab(tab);
          sendResponse({ ok: true, mode: isPdf ? "pdf" : "webpage" });
        } catch {
          sendResponse({ ok: true, mode: "webpage" });
        }
        return;
      }

      if (message?.type === "LISTENMODE_EXTRACT_CONTEXT") {
        const tabId = await getActiveTabId();
        if (tabId == null) {
          sendResponse({ ok: false, error: "No active tab.", retry: true });
          return;
        }
        const tab = await chrome.tabs.get(tabId);
        const isPdf = await resolveIsPdfTab(tab);

        /** @type {{ text: string }} */
        let payload;
        if (isPdf) {
          try {
            const url = String(tab?.url || "");
            const out = await parsePDFInOffscreen(url);
            if (!out?.success) throw new Error(String(out?.error || "Could not extract PDF text."));
            payload = { text: String(out.text || "").trim() };
          } catch (e) {
            sendResponse({
              ok: false,
              error: String(e?.message || e),
              retry: true
            });
            return;
          }
        } else {
          try {
            payload = await extractFromTab(tabId);
          } catch (e) {
            sendResponse({
              ok: false,
              error: String(e?.message || e),
              retry: true
            });
            return;
          }
        }

        const context = payloadToContextText(payload);
        const trimmed = context.trim();
        if (!trimmed) {
          sendResponse({
            ok: false,
            error: "No readable text found on this page.",
            retry: true
          });
          return;
        }
        if (trimmed.length < MIN_CONTENT_CHARS) {
          sendResponse({ ok: false, error: "NOT_ENOUGH_CONTENT", retry: true });
          return;
        }
        sendResponse({
          ok: true,
          context,
          tabId,
          sourceMode: isPdf ? "pdf" : "webpage"
        });
        return;
      }
      if (message?.type === "LISTENMODE_GET_ACTIVE_TAB_ID") {
        const tabId = await getActiveTabId();
        sendResponse({ ok: true, tabId });
        return;
      }
      if (message?.type === "LISTENMODE_GENERATE_AI") {
        const mode = message.mode === "understand" ? "understand" : "listen";
        const langCode = message.lang || "en";
        const ctx = String(message.context || "");
        const forceSimplify = message.forceSimplify === true;
        const genOpts = { forceSimplify };
        if (!ctx.trim()) {
          sendResponse({ ok: false, error: "Nothing to read.", retry: true });
          return;
        }
        let text;
        /** @type {string | undefined} */
        let contentType;
        /** @type {string[] | undefined} */
        let sentences;
        /** @type {string[] | undefined} */
        let wordTimings;
        /** @type {string | undefined} */
        let complexity;
        /** @type {string | undefined} */
        let audience;
        /** @type {boolean | undefined} */
        let simplified;
        try {
          if (mode === "understand") {
            const out = await generateUnderstandScript(ctx, langCode, genOpts);
            text = out.script;
            sentences = out.sentences;
            wordTimings = out.wordTimings;
            complexity = out.complexity;
            audience = out.audience;
            simplified = out.simplified;
          } else {
            const out = await generateListenScript(ctx, langCode, genOpts);
            text = out.script;
            contentType = out.contentType;
            sentences = out.sentences;
            wordTimings = out.wordTimings;
            complexity = out.complexity;
            audience = out.audience;
            simplified = out.simplified;
          }
        } catch (e) {
          console.log("[ListenMode] LISTENMODE_GENERATE_AI failed:", e?.message || e, e);
          const msg = String(e?.message || e);
          if (msg === "NETWORK_ERROR") {
            sendResponse({
              ok: false,
              error: "Connection failed. Check your network and try again.",
              retry: true
            });
            return;
          }
          sendResponse({ ok: false, error: msg, retry: true });
          return;
        }
        sendResponse(
          mode === "listen"
            ? {
                ok: true,
                text,
                mode,
                contentType,
                sentences,
                wordTimings,
                complexity,
                audience,
                simplified
              }
            : {
                ok: true,
                text,
                mode,
                sentences,
                wordTimings,
                complexity,
                audience,
                simplified
              }
        );
        return;
      }
      sendResponse({ ok: false, error: "Unknown message.", retry: true });
    } catch (err) {
      console.log("[ListenMode] onMessage handler error:", err?.message || err, err);
      const msg = String(err?.message || err);
      sendResponse({
        ok: false,
        error: msg === "NETWORK_ERROR" ? "Connection failed. Check your network and try again." : msg,
        retry: true
      });
    }
  })();

  return true;
});
