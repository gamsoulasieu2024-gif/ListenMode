import { askAboutPage } from "../utils/ai.js";

/**
 * Bridges playback to the offscreen document so audio continues after the popup closes.
 * @extends EventTarget
 */
class PlaybackProxy extends EventTarget {
  constructor() {
    super();
    /** @private */
    this._paused = false;
    /** @private */
    this._playing = false;
    /** @private */
    this._onMsg = (msg) => {
      if (msg?.type === "LISTENMODE_PLAYBACK_STOPPED") {
        this._playing = false;
        this._paused = false;
        this.dispatchEvent(new CustomEvent("end"));
        return;
      }
      if (msg?.type !== "LISTENMODE_AUDIO_EVENT") return;
      const { event, detail } = msg;
      if (event === "pause") this._paused = true;
      if (event === "resume") this._paused = false;
      if (event === "start") {
        this._playing = true;
        this._paused = false;
      }
      if (event === "end" || event === "playback-error") {
        this._playing = false;
        this._paused = false;
      }
      this.dispatchEvent(new CustomEvent(event, { detail }));
    };
    chrome.runtime.onMessage.addListener(this._onMsg);
    void this._syncFromBackground();
  }

  async _syncFromBackground() {
    try {
      const s = await chrome.runtime.sendMessage({ type: "LISTENMODE_GET_PLAYBACK_STATE" });
      if (!s?.ok || !s.playing) return;
      this._playing = true;
      this._paused = !!s.paused;
      setAudioBarVisible(true);
      setPlaybackBadge(true);
      syncPauseLabel();
      setStatus(this._paused ? "Paused" : lastPlayWasPreview ? "Preview" : "Playing…", {
        busy: false
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string} text
   * @param {string} lang
   * @param {{ apiKey?: string, voiceId?: string, tabId?: number, sentences?: string[], pageTitle?: string }} [options]
   */
  play(text, lang, options = {}) {
    const { pageTitle, ...opts } = options;
    void chrome.runtime.sendMessage({
      type: "LISTENMODE_PLAY",
      text,
      lang,
      options: opts,
      pageTitle: pageTitle || ""
    });
  }

  stop() {
    void chrome.runtime.sendMessage({ type: "LISTENMODE_AUDIO_CMD", cmd: "stop" });
    this._playing = false;
    this._paused = false;
  }

  pause() {
    void chrome.runtime.sendMessage({ type: "LISTENMODE_AUDIO_CMD", cmd: "pause" });
  }

  resume() {
    void chrome.runtime.sendMessage({ type: "LISTENMODE_AUDIO_CMD", cmd: "resume" });
  }

  /**
   * @param {number} [seconds]
   */
  rewind(seconds = 5) {
    void chrome.runtime.sendMessage({ type: "LISTENMODE_AUDIO_CMD", cmd: "rewind", seconds });
  }

  /**
   * @param {number} rate
   */
  setSpeed(rate) {
    void chrome.runtime.sendMessage({ type: "LISTENMODE_AUDIO_CMD", cmd: "setSpeed", rate });
  }

  /**
   * @returns {boolean}
   */
  isPlaybackPaused() {
    return this._paused;
  }
}

const STORAGE_MODE = "listenMode";
const STORAGE_LANG = "listenModeLang";
const STORAGE_GEMINI_KEY = "gemini_api_key";
const STORAGE_ELEVENLABS_KEY = "elevenlabs_api_key";
const STORAGE_ELEVENLABS_VOICE = "listenModeElevenLabsVoice";
/** Last successful script keyed by content hash + mode + language (repeatable playback). */
const STORAGE_SCRIPT_CACHE = "listenModeScriptCache";
const STORAGE_SIMPLIFY = "listenModeSimplify";
const STORAGE_DYSLEXIA = "listenModeDyslexia";

const KEY_MISSING_MSG = "Add your Gemini API key in Settings first.";
const NOT_ENOUGH_CONTENT_MSG =
  "🙁 This page doesn't have enough text to listen to";
const AUDIO_UNSUPPORTED_MSG =
  "Audio not supported in this browser. Try Chrome or Edge.";
const ELEVENLABS_401_MSG = "Invalid ElevenLabs key — check Settings";
const PREVIEW_MAX_WORDS = 100;

const $ = (id) => document.getElementById(id);

const btnSettings = $("btn-settings");
const settingsView = $("settings-view");
const btnSettingsBack = $("btn-settings-back");
const apiKeyInput = $("api-key");
const apiKeySaved = $("api-key-saved");
const btnSaveKey = $("btn-save-key");
const elevenlabsApiKeyInput = $("elevenlabs-api-key");
const elevenlabsApiKeySaved = $("elevenlabs-api-key-saved");
const btnSaveElevenlabsKey = $("btn-save-elevenlabs-key");
const voiceCards = $("voice-cards");
const voiceField = $("voice-field");
const btnPreview = $("btn-preview");
const nowPlayingBar = $("now-playing-bar");
const nowPlayingType = $("now-playing-type");
const nowPlayingTime = $("now-playing-time");
const saveFeedback = $("save-feedback");
const modeListen = $("mode-listen");
const modeUnderstand = $("mode-understand");
const langSelect = $("lang-select");
const btnStart = $("btn-start");
const btnFresh = $("btn-fresh");
const btnStartNormal = $("btn-start-normal");
const btnStartBusy = $("btn-start-busy");
const audioBar = $("audio-bar");
const btnRewind = $("btn-rewind");
const btnPause = $("btn-pause");
const pauseLabel = $("pause-label");
const btnAudioStop = $("btn-audio-stop");
const speedBtns = document.querySelectorAll("#speed-btns .speed-btn");
const statusRow = $("status-row");
const statusText = $("status-text");
const spinner = $("spinner");
const errorBox = $("error-box");
const errorText = $("error-text");
const btnRetry = $("btn-retry");
const outputPanel = $("output-panel");
const outputHeading = $("output-heading");
const outputBody = $("output-body");
const contentTypeLabel = $("content-type-label");
const simplifyToggle = $("simplify-toggle");
const dyslexiaToggle = $("dyslexia-toggle");
const askPageSection = $("ask-page-section");
const askPageInput = $("ask-page-input");
const btnAskPage = $("btn-ask-page");
const askPageMessages = $("ask-page-messages");
const sourceBadge = $("source-badge");
const popupDyslexiaLayer = $("popup-dyslexia-layer");
const popupDyslexiaScroll = $("popup-dyslexia-scroll");
const popupDyslexiaExit = $("popup-dyslexia-exit");

/** @type {((e: KeyboardEvent) => void) | null} */
let popupDyslexiaEscHandler = null;

const speech = new PlaybackProxy();

let currentMode = "listen";

/** @type {{ context: string, mode: string, lang: string, tabId?: number, lastFlow?: "full" | "preview", sourceMode?: "pdf" | "webpage" } | null} */
let retryState = null;

/** Sync with speech "start" so status shows "Preview" vs "Playing…". */
let lastPlayWasPreview = false;

/** Unlocks Ask the Page after the first playback start this popup session. */
let audioHasStartedThisSession = false;

function revealAskPageSection() {
  if (!askPageSection || audioHasStartedThisSession) return;
  audioHasStartedThisSession = true;
  askPageSection.hidden = false;
}

function hidePopupDyslexia() {
  if (popupDyslexiaEscHandler) {
    document.removeEventListener("keydown", popupDyslexiaEscHandler, true);
    popupDyslexiaEscHandler = null;
  }
  document.body.classList.remove("pdf-dyslexia-wide");
  if (popupDyslexiaScroll) popupDyslexiaScroll.textContent = "";
  if (popupDyslexiaLayer) {
    popupDyslexiaLayer.hidden = true;
    popupDyslexiaLayer.setAttribute("aria-hidden", "true");
  }
}

/**
 * @param {unknown[]} sentences
 */
function showPopupDyslexia(sentences) {
  if (!popupDyslexiaScroll || !popupDyslexiaLayer) return;
  popupDyslexiaScroll.textContent = "";
  const list = Array.isArray(sentences)
    ? sentences.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  for (let i = 0; i < list.length; i++) {
    const p = document.createElement("p");
    p.className = "popup-dyslexia-sent";
    p.dataset.idx = String(i);
    p.textContent = list[i];
    popupDyslexiaScroll.appendChild(p);
  }
  document.body.classList.add("pdf-dyslexia-wide");
  popupDyslexiaLayer.hidden = false;
  popupDyslexiaLayer.setAttribute("aria-hidden", "false");
  const first = popupDyslexiaScroll.querySelector(".popup-dyslexia-sent");
  first?.classList.add("is-active");
  first?.scrollIntoView({ block: "center", behavior: "auto" });

  if (popupDyslexiaEscHandler) {
    document.removeEventListener("keydown", popupDyslexiaEscHandler, true);
  }
  popupDyslexiaEscHandler = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    speech.stop();
  };
  document.addEventListener("keydown", popupDyslexiaEscHandler, true);
}

/**
 * @param {number} index
 */
function highlightPopupDyslexia(index) {
  if (!popupDyslexiaScroll) return;
  const paras = popupDyslexiaScroll.querySelectorAll(".popup-dyslexia-sent");
  const n = paras.length;
  if (!n) return;
  const idx = Math.max(0, Math.min(n - 1, Math.floor(Number(index) || 0)));
  paras.forEach((p) => p.classList.remove("is-active"));
  const el = paras[idx];
  if (el) {
    el.classList.add("is-active");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

async function syncSourceModeBadge() {
  if (!sourceBadge) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: "LISTENMODE_GET_SOURCE_MODE" });
    sourceBadge.hidden = !(r?.ok && r.mode === "pdf");
  } catch {
    sourceBadge.hidden = true;
  }
}

/**
 * @param {string} question
 * @param {string} answer
 */
function appendAskQaPair(question, answer) {
  if (!askPageMessages) return;
  const pairs = askPageMessages.querySelectorAll(".ask-qa-pair");
  if (pairs.length >= 3) {
    pairs[0].remove();
  }

  const wrap = document.createElement("div");
  wrap.className = "ask-qa-pair";

  const qEl = document.createElement("div");
  qEl.className = "ask-qa-q";
  qEl.textContent = question;

  const aEl = document.createElement("div");
  aEl.className = "ask-qa-a";
  aEl.textContent = answer;

  wrap.appendChild(qEl);
  wrap.appendChild(aEl);
  askPageMessages.appendChild(wrap);
  askPageMessages.scrollTop = askPageMessages.scrollHeight;
}

async function submitAskPage() {
  const q = askPageInput?.value.trim() || "";
  if (!q || !retryState?.context) return;

  const typingEl = document.createElement("div");
  typingEl.className = "ask-typing";
  typingEl.textContent = "...";
  typingEl.setAttribute("aria-hidden", "true");
  askPageMessages?.appendChild(typingEl);
  if (askPageMessages) {
    askPageMessages.scrollTop = askPageMessages.scrollHeight;
  }

  if (askPageInput) askPageInput.disabled = true;
  if (btnAskPage) btnAskPage.disabled = true;

  try {
    const answer = await askAboutPage(q, retryState.context, getLang());
    typingEl.remove();
    appendAskQaPair(q, answer);
    if (askPageInput) askPageInput.value = "";
  } catch (e) {
    typingEl.remove();
    appendAskQaPair(q, friendlyError(String(e?.message || e)));
  } finally {
    if (askPageInput) askPageInput.disabled = false;
    if (btnAskPage) btnAskPage.disabled = false;
    askPageInput?.focus();
  }
}

function getLang() {
  return langSelect.value || "en";
}

function isSpeechSupported() {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    !!window.speechSynthesis
  );
}

function hasWebAudio() {
  return (
    typeof window !== "undefined" &&
    (typeof AudioContext !== "undefined" ||
      typeof window.webkitAudioContext !== "undefined")
  );
}

/**
 * ElevenLabs when key present; otherwise browser speech synthesis.
 * @param {string} elevenLabsKey
 */
function isPlaybackSupported(elevenLabsKey) {
  if (String(elevenLabsKey || "").trim()) {
    return hasWebAudio();
  }
  return isSpeechSupported();
}

/**
 * Badge while audio plays (popup may close; the browser stops TTS when it does — we clear on pagehide).
 * Chrome cannot keep the popup open; the badge is a lightweight “audio was playing” hint.
 */
function setPlaybackBadge(playing) {
  if (!chrome.action?.setBadgeText) return;
  if (playing) {
    chrome.action.setBadgeText({ text: "♪" });
    chrome.action.setBadgeBackgroundColor({ color: "#0d9488" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function setMode(mode) {
  currentMode = mode === "understand" ? "understand" : "listen";
  modeListen.classList.toggle("is-active", currentMode === "listen");
  modeUnderstand.classList.toggle("is-active", currentMode === "understand");
  modeListen.setAttribute("aria-pressed", currentMode === "listen" ? "true" : "false");
  modeUnderstand.setAttribute(
    "aria-pressed",
    currentMode === "understand" ? "true" : "false"
  );
  chrome.storage.local.set({ [STORAGE_MODE]: currentMode });
  if (currentMode === "understand") {
    setContentMetaLabel(null);
  }
}

function friendlyError(msg) {
  const s = String(msg || "Something went wrong.");
  if (s === "NOT_ENOUGH_CONTENT" || s.includes("NOT_ENOUGH_CONTENT")) {
    return NOT_ENOUGH_CONTENT_MSG;
  }
  if (s.includes("Add your Gemini API key in Settings first")) {
    return KEY_MISSING_MSG;
  }
  if (s === ELEVENLABS_401_MSG || /ELEVENLABS_401/i.test(s)) {
    return ELEVENLABS_401_MSG;
  }
  if (/Too many requests — wait/i.test(s)) {
    return "Too many requests — wait a moment and retry";
  }
  if (/api key|Invalid API key|access denied/i.test(s)) {
    return "Invalid API key or access denied. Check your key in Settings.";
  }
  if (/No readable text/i.test(s)) {
    return NOT_ENOUGH_CONTENT_MSG;
  }
  if (/Failed to fetch|network|Connection failed|NETWORK_ERROR/i.test(s)) {
    return "Connection failed. Check your network and try again.";
  }
  if (/Rate limit/i.test(s)) {
    return "Too many requests — wait a moment and retry";
  }
  return s;
}

function clearError() {
  errorBox.hidden = true;
  errorText.textContent = "";
  btnRetry.hidden = true;
}

/**
 * @param {string} msg
 * @param {{ retry?: boolean }} [opts]
 */
function showError(msg, opts = {}) {
  const { retry = true } = opts;
  errorText.textContent = friendlyError(msg);
  btnRetry.hidden = !retry;
  errorBox.hidden = false;
}

function setStatus(text, opts = {}) {
  const { busy = false } = opts;
  statusText.textContent = text || "";
  spinner.hidden = !busy;
  statusRow.classList.toggle("is-busy", busy);
}

function setProcessing(on) {
  btnStart.disabled = on;
  if (btnFresh) btnFresh.disabled = on;
  if (btnPreview) btnPreview.disabled = on;
  if (btnStartNormal && btnStartBusy) {
    btnStartNormal.hidden = on;
    btnStartBusy.hidden = !on;
  }
}

/** Stops speech and hides transport; keeps speed selection (new run starting). */
function silencePlaybackAndBadge() {
  hidePopupDyslexia();
  speech.stop();
  setAudioBarVisible(false);
  setNowPlayingBar(false, { mode: "listen", contentType: null, wordCount: 0 });
  setPlaybackBadge(false);
  setStatus("");
  syncPauseLabel();
}

/** After playback finishes or user stops: full UI reset including 1× speed. */
function resetControlsToInitialState() {
  hidePopupDyslexia();
  setAudioBarVisible(false);
  setNowPlayingBar(false, { mode: "listen", contentType: null, wordCount: 0 });
  setStatus("");
  syncPauseLabel();
  speedBtns.forEach((b) => b.classList.remove("is-active"));
  document.querySelector('#speed-btns .speed-btn[data-rate="1"]')?.classList.add("is-active");
  speech.setSpeed(1);
  setPlaybackBadge(false);
}

function persistLang() {
  chrome.storage.local.set({ [STORAGE_LANG]: getLang() });
}

async function openSettings() {
  updateSavedKeyHint(await getStoredApiKey());
  updateElevenlabsSavedHint(await getStoredElevenlabsKey());
  settingsView.classList.add("is-open");
  settingsView.setAttribute("aria-hidden", "false");
  btnSettings.setAttribute("aria-expanded", "true");
  apiKeyInput.value = "";
  if (elevenlabsApiKeyInput) elevenlabsApiKeyInput.value = "";
  apiKeyInput.focus();
}

function closeSettings() {
  settingsView.classList.remove("is-open");
  settingsView.setAttribute("aria-hidden", "true");
  btnSettings.setAttribute("aria-expanded", "false");
  saveFeedback.textContent = "";
}

function updateSavedKeyHint(key) {
  const k = String(key || "").trim();
  if (k.length >= 4) {
    apiKeySaved.textContent = `Saved key ends in ····${k.slice(-4)}`;
    apiKeySaved.hidden = false;
  } else {
    apiKeySaved.textContent = "";
    apiKeySaved.hidden = true;
  }
}

async function getStoredApiKey() {
  const { [STORAGE_GEMINI_KEY]: key } = await chrome.storage.local.get(STORAGE_GEMINI_KEY);
  return String(key || "").trim();
}

async function getStoredElevenlabsKey() {
  const { [STORAGE_ELEVENLABS_KEY]: key } = await chrome.storage.local.get(STORAGE_ELEVENLABS_KEY);
  return String(key || "").trim();
}

function updateElevenlabsSavedHint(key) {
  if (!elevenlabsApiKeySaved) return;
  const k = String(key || "").trim();
  if (k.length >= 4) {
    elevenlabsApiKeySaved.textContent = `Saved key ends in ····${k.slice(-4)}`;
    elevenlabsApiKeySaved.hidden = false;
  } else {
    elevenlabsApiKeySaved.textContent = "";
    elevenlabsApiKeySaved.hidden = true;
  }
}

function updateVoiceFieldState(elevenLabsKeyPresent) {
  if (!voiceField) return;
  const on = !!elevenLabsKeyPresent;
  voiceField.classList.toggle("is-disabled", !on);
  voiceCards?.querySelectorAll(".voice-card").forEach((btn) => {
    /** @type {HTMLButtonElement} */ (btn).disabled = !on;
  });
}

function getSelectedVoiceId() {
  const el = document.querySelector("#voice-cards .voice-card.is-selected");
  return el?.dataset?.voiceId || "21m00Tcm4TlvDq8ikWAM";
}

/**
 * @param {string} voiceId
 */
function selectVoiceCardById(voiceId) {
  const id = String(voiceId || "").trim() || "21m00Tcm4TlvDq8ikWAM";
  voiceCards?.querySelectorAll(".voice-card").forEach((btn) => {
    const on = btn.getAttribute("data-voice-id") === id;
    btn.classList.toggle("is-selected", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  chrome.storage.local.set({ [STORAGE_ELEVENLABS_VOICE]: id });
}

/**
 * @param {string} text
 */
function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * @param {number} wc
 */
function formatListenEta(wc) {
  const mins = wc / 150;
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))} sec`;
  if (mins < 10) return `${mins.toFixed(1)} min`;
  return `${Math.round(mins)} min`;
}

/**
 * @param {string} text
 * @param {string[] | null | undefined} sentences
 * @param {number} [maxWords]
 */
function truncateForPreview(text, sentences, maxWords = PREVIEW_MAX_WORDS) {
  const raw = String(text || "").trim();
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return {
      text: raw,
      sentences: sentences?.length ? sentences : null
    };
  }
  const short = words.slice(0, maxWords).join(" ");
  if (!sentences?.length) {
    return { text: short, sentences: null };
  }
  let used = 0;
  /** @type {string[]} */
  const out = [];
  for (const s of sentences) {
    const sw = String(s).trim().split(/\s+/).filter(Boolean).length;
    if (used + sw > maxWords) break;
    out.push(s);
    used += sw;
  }
  return { text: short, sentences: out.length ? out : null };
}

/**
 * @param {boolean} visible
 * @param {{ mode: string, contentType: string | null, wordCount: number }} meta
 */
function setNowPlayingBar(visible, meta) {
  if (!nowPlayingBar) return;
  if (!visible) {
    nowPlayingBar.hidden = true;
    return;
  }
  const typeLabel =
    meta.mode === "listen" && meta.contentType
      ? formatContentTypeForUi(meta.contentType)
      : meta.mode === "understand"
        ? "Explain"
        : "Listen";
  const wc = Math.max(0, meta.wordCount || 0);
  const eta = formatListenEta(wc);
  if (nowPlayingType) {
    nowPlayingType.textContent = `${typeLabel} · ${wc} words`;
  }
  if (nowPlayingTime) {
    nowPlayingTime.textContent = `~${eta} listen`;
  }
  nowPlayingBar.hidden = false;
}

/**
 * @param {string} context
 * @returns {Promise<string>} Hex SHA-256 of page text for cache keys
 */
async function hashContext(context) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(context || "")));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @param {string} fp
 * @param {string} mode
 * @param {string} lang
 * @param {boolean} [forceSimplify]
 * @returns {Promise<{ text: string, contentType: string | null, sentences: string[] | null, wordTimings: string[] | null, complexity?: string, audience?: string, simplified?: boolean } | null>}
 */
async function getCachedScript(fp, mode, lang, forceSimplify = false) {
  const { [STORAGE_SCRIPT_CACHE]: row } = await chrome.storage.local.get(STORAGE_SCRIPT_CACHE);
  if (!row || row.fp !== fp || row.mode !== mode || row.lang !== lang) return null;
  const rowSimplify = row.forceSimplify === true;
  if (rowSimplify !== !!forceSimplify) return null;
  const text = String(row.text || "").trim();
  if (!text) return null;
  const contentType =
    row.contentType != null && String(row.contentType).trim()
      ? String(row.contentType).trim()
      : null;
  const sentences = Array.isArray(row.sentences) ? row.sentences.map(String) : null;
  const wordTimings = Array.isArray(row.wordTimings) ? row.wordTimings.map(String) : null;
  const complexity = row.complexity != null ? String(row.complexity) : "";
  const audience = row.audience != null ? String(row.audience) : "";
  const simplified = row.simplified === true;
  return { text, contentType, sentences, wordTimings, complexity, audience, simplified };
}

/**
 * @param {string} fp
 * @param {string} mode
 * @param {string} lang
 * @param {string} text
 * @param {string | null} [contentType] Listen mode only; stored for the UI label.
 * @param {string[] | null} [sentences]
 * @param {string[] | null} [wordTimings]
 * @param {{ forceSimplify?: boolean, complexity?: string, audience?: string, simplified?: boolean }} [meta]
 */
async function setCachedScript(
  fp,
  mode,
  lang,
  text,
  contentType = null,
  sentences = null,
  wordTimings = null,
  meta = {}
) {
  const { forceSimplify = false, complexity = "", audience = "", simplified = false } = meta;
  const payload = {
    fp,
    mode,
    lang,
    text: String(text || ""),
    forceSimplify: !!forceSimplify,
    complexity: String(complexity || ""),
    audience: String(audience || ""),
    simplified: !!simplified
  };
  if (mode === "listen" && contentType) {
    payload.contentType = String(contentType);
  }
  if (sentences && sentences.length > 0) {
    payload.sentences = sentences;
    payload.wordTimings =
      wordTimings && wordTimings.length > 0 ? wordTimings : sentences;
  }
  await chrome.storage.local.set({ [STORAGE_SCRIPT_CACHE]: payload });
}

/**
 * @param {string} slug
 */
function formatContentTypeForUi(slug) {
  const s = String(slug || "").toLowerCase().trim();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {string} complexity
 * @param {string} audience
 * @param {boolean} simplified
 */
function formatDifficultyBadge(complexity, audience, simplified) {
  if (simplified) return "🎓 Simple";
  const c = formatContentTypeForUi(String(complexity || "intermediate"));
  const aud = String(audience || "general").toLowerCase().trim();
  if (aud === "general") return `🎓 ${c}`;
  return `🎓 ${c} · ${formatContentTypeForUi(aud)}`;
}

/**
 * @param {null | { mode?: string, contentType?: string | null, complexity?: string | null, audience?: string | null, simplified?: boolean }} meta
 */
function setContentMetaLabel(meta) {
  if (!contentTypeLabel) return;
  if (!meta || typeof meta !== "object") {
    contentTypeLabel.hidden = true;
    contentTypeLabel.textContent = "";
    return;
  }
  const mode = meta.mode === "understand" ? "understand" : "listen";
  const type = meta.contentType != null ? String(meta.contentType).trim() : "";
  const simplified = !!meta.simplified;
  const complexity = meta.complexity != null ? String(meta.complexity) : "";
  const audience = meta.audience != null ? String(meta.audience) : "";
  const badge = formatDifficultyBadge(complexity, audience, simplified);

  if (mode === "understand") {
    contentTypeLabel.textContent = `🧠 Explain  •  ${badge}`;
    contentTypeLabel.hidden = false;
    return;
  }

  if (type) {
    contentTypeLabel.textContent = `📄 ${formatContentTypeForUi(type)}  •  ${badge}`;
    contentTypeLabel.hidden = false;
    return;
  }

  contentTypeLabel.textContent = badge;
  contentTypeLabel.hidden = false;
}

function getForceSimplify() {
  return !!(simplifyToggle && /** @type {HTMLInputElement} */ (simplifyToggle).checked);
}

function getDyslexiaMode() {
  return !!(dyslexiaToggle && /** @type {HTMLInputElement} */ (dyslexiaToggle).checked);
}

async function migrateLegacyApiKey() {
  const {
    [STORAGE_GEMINI_KEY]: gemini,
    openai_api_key: openaiUnderscore,
    openaiApiKey: legacyCamel
  } = await chrome.storage.local.get([
    STORAGE_GEMINI_KEY,
    "openai_api_key",
    "openaiApiKey"
  ]);
  if (!gemini && openaiUnderscore) {
    await chrome.storage.local.set({ [STORAGE_GEMINI_KEY]: openaiUnderscore });
    await chrome.storage.local.remove("openai_api_key");
  } else if (!gemini && legacyCamel) {
    await chrome.storage.local.set({ [STORAGE_GEMINI_KEY]: legacyCamel });
    await chrome.storage.local.remove("openaiApiKey");
  }
}

async function saveApiKeyFromInput() {
  const raw = apiKeyInput.value.trim();
  if (!raw) {
    saveFeedback.textContent = "Enter a key to save, or leave as-is.";
    return;
  }
  await chrome.storage.local.set({ [STORAGE_GEMINI_KEY]: raw });
  apiKeyInput.value = "";
  updateSavedKeyHint(raw);
  saveFeedback.textContent = "Saved.";
  setTimeout(() => {
    saveFeedback.textContent = "";
  }, 2500);
}

async function saveElevenlabsKeyFromInput() {
  const raw = elevenlabsApiKeyInput?.value.trim() || "";
  if (!raw) {
    saveFeedback.textContent = "Enter an ElevenLabs key to save, or leave as-is.";
    return;
  }
  await chrome.storage.local.set({ [STORAGE_ELEVENLABS_KEY]: raw });
  if (elevenlabsApiKeyInput) elevenlabsApiKeyInput.value = "";
  updateElevenlabsSavedHint(raw);
  updateVoiceFieldState(true);
  saveFeedback.textContent = "ElevenLabs key saved.";
  setTimeout(() => {
    saveFeedback.textContent = "";
  }, 2500);
}

async function loadPrefs() {
  await migrateLegacyApiKey();
  const {
    [STORAGE_MODE]: mode,
    [STORAGE_LANG]: lang,
    [STORAGE_ELEVENLABS_VOICE]: voiceId,
    [STORAGE_SIMPLIFY]: simplify,
    [STORAGE_DYSLEXIA]: dyslexia
  } = await chrome.storage.local.get([
    STORAGE_MODE,
    STORAGE_LANG,
    STORAGE_ELEVENLABS_VOICE,
    STORAGE_SIMPLIFY,
    STORAGE_DYSLEXIA
  ]);
  const key = await getStoredApiKey();
  updateSavedKeyHint(key);
  const elKey = await getStoredElevenlabsKey();
  updateElevenlabsSavedHint(elKey);
  updateVoiceFieldState(!!elKey);

  if (mode === "understand" || mode === "listen") {
    setMode(mode);
  }
  if (lang && langSelect.querySelector(`option[value="${lang}"]`)) {
    langSelect.value = lang;
  }
  if (voiceId && voiceCards?.querySelector(`[data-voice-id="${voiceId}"]`)) {
    selectVoiceCardById(voiceId);
  }
  if (simplifyToggle) {
    simplifyToggle.checked = simplify === true;
  }
  if (dyslexiaToggle) {
    dyslexiaToggle.checked = dyslexia === true;
  }
  await syncSourceModeBadge();
}

btnSettings.addEventListener("click", () => openSettings());
btnSettingsBack.addEventListener("click", () => closeSettings());
btnSaveKey.addEventListener("click", () => saveApiKeyFromInput());
btnSaveElevenlabsKey?.addEventListener("click", () => saveElevenlabsKeyFromInput());

modeListen.addEventListener("click", () => setMode("listen"));
modeUnderstand.addEventListener("click", () => setMode("understand"));

langSelect.addEventListener("change", persistLang);

simplifyToggle?.addEventListener("change", () => {
  void chrome.storage.local.set({ [STORAGE_SIMPLIFY]: getForceSimplify() });
});

dyslexiaToggle?.addEventListener("change", () => {
  void chrome.storage.local.set({ [STORAGE_DYSLEXIA]: getDyslexiaMode() });
});

voiceCards?.addEventListener("click", (e) => {
  const btn = /** @type {HTMLElement | null} */ (e.target).closest(".voice-card");
  if (!btn || /** @type {HTMLButtonElement} */ (btn).disabled) return;
  const id = btn.getAttribute("data-voice-id");
  if (id) selectVoiceCardById(id);
});

function syncPauseLabel() {
  if (!pauseLabel) return;
  const paused = speech.isPlaybackPaused();
  pauseLabel.textContent = paused ? "Resume" : "Pause";
}

function setAudioBarVisible(show) {
  audioBar.hidden = !show;
}

function applySpeedFromUI() {
  const active = document.querySelector("#speed-btns .speed-btn.is-active");
  const rate = active ? Number(active.dataset.rate) : 1;
  speech.setSpeed(rate);
}

speedBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    speedBtns.forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    applySpeedFromUI();
  });
});

speech.addEventListener("start", () => {
  revealAskPageSection();
  setAudioBarVisible(true);
  applySpeedFromUI();
  setStatus(lastPlayWasPreview ? "Preview" : "Playing…", { busy: false });
  syncPauseLabel();
  setPlaybackBadge(true);
});

speech.addEventListener("playback-error", (e) => {
  const code = /** @type {CustomEvent} */ (e).detail?.code;
  if (code === "ELEVENLABS_401") {
    showError(ELEVENLABS_401_MSG);
  }
});

speech.addEventListener("end", () => {
  resetControlsToInitialState();
});

speech.addEventListener("pause", () => syncPauseLabel());
speech.addEventListener("resume", () => syncPauseLabel());

speech.addEventListener("progress", () => {
  syncPauseLabel();
});

btnPause.addEventListener("click", () => {
  if (speech.isPlaybackPaused()) {
    speech.resume();
  } else {
    speech.pause();
  }
  syncPauseLabel();
});

btnRewind.addEventListener("click", () => {
  speech.rewind(5);
  syncPauseLabel();
});

btnAudioStop.addEventListener("click", () => {
  speech.stop();
  resetControlsToInitialState();
});

btnAskPage?.addEventListener("click", () => {
  void submitAskPage();
});

askPageInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void submitAskPage();
  }
});

window.addEventListener("pagehide", () => {
  setPlaybackBadge(false);
});

/**
 * @param {number | undefined} tabId
 * @returns {Promise<string>}
 */
async function getTabTitle(tabId) {
  if (tabId == null) return "";
  try {
    const t = await chrome.tabs.get(tabId);
    return (t.title || "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * @param {string} context
 * @param {string} lang
 * @param {string} mode
 * @param {{ skipCache?: boolean, tabId?: number, preview?: boolean, sourceMode?: "pdf" | "webpage" }} [opts]
 */
async function generateAndPlay(context, lang, mode, opts = {}) {
  const { skipCache = false, tabId: tabIdOpt, preview = false, sourceMode: sourceModeOpt } = opts;
  const sourceMode =
    sourceModeOpt === "pdf"
      ? "pdf"
      : sourceModeOpt === "webpage"
        ? "webpage"
        : retryState?.sourceMode === "pdf"
          ? "pdf"
          : "webpage";
  const fp = await hashContext(context);
  const elevenKey = await getStoredElevenlabsKey();
  const voiceId = getSelectedVoiceId();
  const forceSimplify = getForceSimplify();

  let tabId = tabIdOpt ?? retryState?.tabId;
  if (tabId == null) {
    const t = await chrome.runtime.sendMessage({ type: "LISTENMODE_GET_ACTIVE_TAB_ID" });
    if (t?.ok && t.tabId != null) tabId = t.tabId;
  }

  const pageTitle = await getTabTitle(tabId);

  const playOpts = {
    apiKey: elevenKey,
    voiceId,
    tabId: tabId != null ? tabId : undefined,
    pageTitle,
    dyslexiaMode: getDyslexiaMode(),
    dyslexiaInPopup: getDyslexiaMode() && sourceMode === "pdf"
  };

  if (!skipCache) {
    const cached = await getCachedScript(fp, mode, lang, forceSimplify);
    if (cached) {
      if (!isPlaybackSupported(elevenKey)) {
        setStatus("");
        showError(AUDIO_UNSUPPORTED_MSG, { retry: false });
        return false;
      }
      setStatus(preview ? "Preview" : "Playing saved script…", { busy: false });
      const cx =
        cached.complexity != null && String(cached.complexity).trim()
          ? String(cached.complexity)
          : "intermediate";
      const aud =
        cached.audience != null && String(cached.audience).trim()
          ? String(cached.audience)
          : "general";
      setContentMetaLabel({
        mode,
        contentType: mode === "listen" ? cached.contentType : null,
        complexity: cx,
        audience: aud,
        simplified: !!cached.simplified
      });
      if (mode === "understand") {
        outputHeading.textContent = "Explanation";
        outputBody.textContent = cached.text;
        outputPanel.hidden = false;
      }
      const cachedSents = cached.sentences?.length
        ? cached.sentences
        : cached.wordTimings;
      const truncated = preview
        ? truncateForPreview(cached.text, cachedSents || null)
        : { text: cached.text, sentences: cachedSents?.length ? cachedSents : null };
      const playText = truncated.text;
      const playSents = truncated.sentences;
      const wc = countWords(playText);
      setNowPlayingBar(true, {
        mode,
        contentType: mode === "listen" ? cached.contentType : null,
        wordCount: wc
      });
      applySpeedFromUI();
      lastPlayWasPreview = preview;
      speech.play(playText, lang, {
        ...playOpts,
        sentences: playSents?.length ? playSents : undefined,
        pageTitle
      });
      return true;
    }
  }

  setStatus("Generating script…", { busy: true });

  const gen = await chrome.runtime.sendMessage({
    type: "LISTENMODE_GENERATE_AI",
    mode,
    lang,
    context,
    forceSimplify
  });

  if (!gen?.ok) {
    setStatus("");
    showError(gen?.error || "Generation failed.");
    return false;
  }

  const text = gen.text || "";
  const listenContentType =
    mode === "listen" && gen.contentType ? String(gen.contentType).trim() : null;
  const sentences = Array.isArray(gen.sentences) ? gen.sentences.map(String) : null;
  const wordTimings = Array.isArray(gen.wordTimings) ? gen.wordTimings.map(String) : null;
  await setCachedScript(fp, mode, lang, text, listenContentType, sentences, wordTimings, {
    forceSimplify,
    complexity: gen.complexity != null ? String(gen.complexity) : "",
    audience: gen.audience != null ? String(gen.audience) : "",
    simplified: gen.simplified === true
  });

  if (!isPlaybackSupported(elevenKey)) {
    setStatus("");
    showError(AUDIO_UNSUPPORTED_MSG, { retry: false });
    return false;
  }

  const truncated = preview
    ? truncateForPreview(text, sentences || wordTimings || null)
    : { text, sentences: sentences?.length ? sentences : wordTimings || null };
  const playText = truncated.text;
  const playSents = truncated.sentences;
  const wc = countWords(playText);

  setStatus(preview ? "Preview" : "Playing…", { busy: false });

  setContentMetaLabel({
    mode,
    contentType: listenContentType,
    complexity: gen.complexity != null ? String(gen.complexity) : "",
    audience: gen.audience != null ? String(gen.audience) : "",
    simplified: gen.simplified === true
  });

  if (mode === "understand") {
    outputHeading.textContent = "Explanation";
    outputBody.textContent = text;
    outputPanel.hidden = false;
  }

  setNowPlayingBar(true, {
    mode,
    contentType: mode === "listen" ? listenContentType : null,
    wordCount: wc
  });

  applySpeedFromUI();
  lastPlayWasPreview = preview;
  speech.play(playText, lang, {
    ...playOpts,
    sentences: playSents?.length ? playSents : undefined,
    pageTitle
  });
  return true;
}

/**
 * @param {{ skipCache?: boolean }} [opts]
 */
async function runStartFlow(opts = {}) {
  const { skipCache = false } = opts;
  clearError();
  silencePlaybackAndBadge();
  outputPanel.hidden = true;
  outputBody.textContent = "";
  setContentMetaLabel(null);

  const hasKey = await getStoredApiKey();
  if (!hasKey) {
    showError(KEY_MISSING_MSG, { retry: false });
    return;
  }

  const lang = getLang();
  const mode = currentMode;

  retryState = null;
  setProcessing(true);
  try {
    const src = await chrome.runtime.sendMessage({ type: "LISTENMODE_GET_SOURCE_MODE" });
    setStatus(src?.mode === "pdf" ? "Reading PDF…" : "Extracting page…", { busy: false });

    const ext = await chrome.runtime.sendMessage({ type: "LISTENMODE_EXTRACT_CONTEXT" });
    if (!ext?.ok) {
      showError(ext?.error || "Could not read this page.");
      setStatus("");
      return;
    }

    const sourceMode = ext.sourceMode === "pdf" ? "pdf" : "webpage";
    retryState = {
      context: ext.context,
      mode,
      lang,
      tabId: ext.tabId != null ? ext.tabId : undefined,
      lastFlow: "full",
      sourceMode
    };

    await generateAndPlay(ext.context, lang, mode, {
      skipCache,
      tabId: ext.tabId != null ? ext.tabId : undefined,
      preview: false,
      sourceMode
    });
  } catch (e) {
    showError(String(e?.message || e), { retry: true });
    setStatus("");
  } finally {
    setProcessing(false);
    spinner.hidden = true;
    statusRow.classList.remove("is-busy");
  }
}

async function runRetryFlow() {
  clearError();
  silencePlaybackAndBadge();
  setContentMetaLabel(null);

  const hasKey = await getStoredApiKey();
  if (!hasKey) {
    showError(KEY_MISSING_MSG, { retry: false });
    return;
  }

  if (!retryState) {
    void runStartFlow({ skipCache: false });
    return;
  }

  const { context, mode, lang, tabId, lastFlow, sourceMode } = retryState;
  setProcessing(true);
  try {
    setStatus("Generating script…", { busy: true });
    await generateAndPlay(context, lang, mode, {
      skipCache: true,
      tabId,
      preview: lastFlow === "preview",
      sourceMode: sourceMode ?? "webpage"
    });
  } catch (e) {
    showError(String(e?.message || e));
    setStatus("");
  } finally {
    setProcessing(false);
    spinner.hidden = true;
    statusRow.classList.remove("is-busy");
  }
}

btnStart.addEventListener("click", () => runStartFlow({ skipCache: false }));
btnFresh.addEventListener("click", () => runStartFlow({ skipCache: true }));
btnPreview?.addEventListener("click", () => runPreviewFlow());
btnRetry.addEventListener("click", () => runRetryFlow());

async function runPreviewFlow() {
  clearError();
  silencePlaybackAndBadge();
  outputPanel.hidden = true;
  outputBody.textContent = "";
  setContentMetaLabel(null);

  const hasKey = await getStoredApiKey();
  if (!hasKey) {
    showError(KEY_MISSING_MSG, { retry: false });
    return;
  }

  const lang = getLang();
  const mode = currentMode;

  retryState = null;
  setProcessing(true);
  try {
    const src = await chrome.runtime.sendMessage({ type: "LISTENMODE_GET_SOURCE_MODE" });
    setStatus(src?.mode === "pdf" ? "Reading PDF…" : "Extracting page…", { busy: false });

    const ext = await chrome.runtime.sendMessage({ type: "LISTENMODE_EXTRACT_CONTEXT" });
    if (!ext?.ok) {
      showError(ext?.error || "Could not read this page.");
      setStatus("");
      return;
    }

    const sourceMode = ext.sourceMode === "pdf" ? "pdf" : "webpage";
    retryState = {
      context: ext.context,
      mode,
      lang,
      tabId: ext.tabId != null ? ext.tabId : undefined,
      lastFlow: "preview",
      sourceMode
    };

    await generateAndPlay(ext.context, lang, mode, {
      skipCache: false,
      tabId: ext.tabId != null ? ext.tabId : undefined,
      preview: true,
      sourceMode
    });
  } catch (e) {
    showError(String(e?.message || e));
    setStatus("");
  } finally {
    setProcessing(false);
    spinner.hidden = true;
    statusRow.classList.remove("is-busy");
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "LISTENMODE_DYSLEXIA_UI") return;
  if (msg.action === "show") {
    showPopupDyslexia(Array.isArray(msg.sentences) ? msg.sentences : []);
  } else if (msg.action === "highlight") {
    highlightPopupDyslexia(Number(msg.index));
  } else if (msg.action === "hide") {
    hidePopupDyslexia();
  }
});

popupDyslexiaExit?.addEventListener("click", () => {
  speech.stop();
});

void loadPrefs();
