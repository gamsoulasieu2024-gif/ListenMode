import AudioPlayer, { AudioPipeline } from "../utils/audio.js";
import * as pdfjsLib from "../libs/pdf.min.mjs";

const player = new AudioPlayer();
let pipeline = null;

/** @type {number | null} */
let activeTabId = null;

/**
 * @param {string} name
 * @param {Record<string, unknown>} [detail]
 */
function relay(name, detail = {}) {
  void chrome.runtime.sendMessage({
    type: "LISTENMODE_AUDIO_EVENT",
    event: name,
    detail,
    tabId: activeTabId
  });
}

player.addEventListener("start", () => {
  relay("start", {});
});

player.addEventListener("end", () => {
  relay("end", {});
  activeTabId = null;
});

player.addEventListener("pause", () => {
  relay("pause", {});
});

player.addEventListener("resume", () => {
  relay("resume", {});
});

player.addEventListener("playback-error", (e) => {
  relay("playback-error", /** @type {CustomEvent} */ (e).detail || {});
});

player.addEventListener("progress", (e) => {
  const d = /** @type {CustomEvent} */ (e).detail || {};
  const pct =
    d.percentage != null
      ? Number(d.percentage)
      : d.percent != null
        ? Number(d.percent)
        : 0;
  const charIndex = d.charIndex != null ? Number(d.charIndex) : undefined;
  relay("progress", { percentage: pct, charIndex, raw: d });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "LISTENMODE_OFFSCREEN_STREAM_INIT") {
    activeTabId =
      msg.options?.tabId != null && Number.isFinite(Number(msg.options.tabId))
        ? Number(msg.options.tabId)
        : null;
    try {
      pipeline?.stop();
    } catch {
      /* ignore */
    }
    pipeline = new AudioPipeline();
    pipeline.addEventListener("start", () => relay("start", {}));
    pipeline.addEventListener("pause", () => relay("pause", {}));
    pipeline.addEventListener("resume", () => relay("resume", {}));
    pipeline.addEventListener("end", () => {
      relay("end", {});
      activeTabId = null;
      pipeline = null;
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "LISTENMODE_OFFSCREEN_STREAM_ADD") {
    if (!pipeline) {
      sendResponse({ ok: false, error: "No active pipeline." });
      return true;
    }
    const { text, voiceId, apiKey } = msg;
    pipeline
      .addSentence(String(text || ""), String(voiceId || ""), String(apiKey || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e), status: e?.status }));
    return true;
  }

  if (msg?.type === "LISTENMODE_OFFSCREEN_PLAY") {
    activeTabId =
      msg.options?.tabId != null && Number.isFinite(Number(msg.options.tabId))
        ? Number(msg.options.tabId)
        : null;
    try {
      player.play(String(msg.text || ""), String(msg.lang || "en"), msg.options || {});
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (msg?.type === "LISTENMODE_OFFSCREEN_CMD") {
    const cmd = msg.cmd;
    try {
      const target = pipeline ? "pipeline" : "player";
      if (cmd === "pause") (pipeline ? pipeline.pause() : player.pause());
      else if (cmd === "resume") (pipeline ? pipeline.resume() : player.resume());
      else if (cmd === "stop") {
        if (pipeline) {
          pipeline.stop();
          pipeline = null;
        } else {
          player.stop();
        }
        activeTabId = null;
      } else if (cmd === "rewind") {
        // Rewind isn't supported for streamed pipelines; ignore.
        if (!pipeline) player.rewind(Number(msg.seconds) || 5);
      } else if (cmd === "setSpeed") {
        if (pipeline) pipeline.setSpeed(Number(msg.rate));
        else player.setSpeed(Number(msg.rate));
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (msg?.type === "LISTENMODE_OFFSCREEN_GET_STATE") {
    if (pipeline) {
      const playing = pipeline.isPlaying && !pipeline.stopped;
      const paused =
        !!pipeline.audioContext && pipeline.audioContext.state === "suspended";
      sendResponse({ ok: true, playing, paused });
    } else {
      const s = player.getPlaybackState();
      sendResponse({ ok: true, ...s });
    }
    return true;
  }

  if (msg?.type === "LISTENMODE_PARSE_PDF") {
    (async () => {
      try {
        const data = new Uint8Array(Array.isArray(msg.data) ? msg.data : []);
        if (!data.byteLength) throw new Error("Missing PDF data");

        const loadingTask = pdfjsLib.getDocument({
          data,
          disableWorker: true,
          isEvalSupported: false,
          useSystemFonts: true
        });

        const pdf = await loadingTask.promise;
        let fullText = "";
        const maxPages = Math.min(Number(pdf.numPages) || 0, 20);

        for (let i = 1; i <= maxPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          fullText += content.items.map((item) => item.str).join(" ") + "\n\n";
        }

        const text = fullText.trim().slice(0, 4000);
        sendResponse({ success: true, text, pageCount: pdf.numPages });
      } catch (err) {
        sendResponse({ success: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  return false;
});

void chrome.runtime.sendMessage({ type: "LISTENMODE_OFFSCREEN_READY" });
