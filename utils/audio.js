/**
 * ElevenLabs TTS (Web Audio API) with Web Speech API fallback.
 */

const BCP47_BY_LANG = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-BR",
  zh: "zh-CN",
  ar: "ar-SA"
};

/** ~150 wpm for rewind heuristics */
const WORDS_PER_SEC = 2.5;

/** Demo voices (ElevenLabs voice IDs). */
export const ELEVENLABS_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "calm, clear" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", description: "confident" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", description: "warm" }
];

/**
 * @param {string} text
 * @param {string} voiceId
 * @param {string} apiKey
 * @returns {Promise<Blob>}
 */
export async function generateElevenLabsAudio(text, voiceId, apiKey) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    }
  );
  if (!res.ok) {
    const err = new Error(`ElevenLabs HTTP ${res.status}`);
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  const blob = await res.blob();
  return new Blob([blob], { type: "audio/mpeg" });
}

export function langCodeToBcp47(code) {
  if (!code) return BCP47_BY_LANG.en;
  const s = String(code).trim();
  if (/^[a-z]{2}-[a-z]{2}$/i.test(s)) {
    const [a, b] = s.split("-");
    return `${a.toLowerCase()}-${b.toUpperCase()}`;
  }
  const lower = s.toLowerCase();
  return BCP47_BY_LANG[lower] || BCP47_BY_LANG.en;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoSentenceChunks(text) {
  if (!text?.trim()) return [];
  const normalized = text.replace(/\s+/g, " ").trim();
  const parts = normalized.split(/(?<=[.!?])\s+/).map((s) => s.trim());
  const out = parts.filter(Boolean);
  if (out.length === 0) return [normalized];
  return out;
}

export default class AudioPlayer extends EventTarget {
  constructor() {
    super();
    /** @type {string[]} */
    this._chunks = [];
    /** @type {number[]} */
    this._chunkWordCounts = [];
    /** @type {number[]} */
    this._chunkStartChar = [];
    /** @type {number} */
    this._currentIndex = 0;
    /** @type {string} */
    this._lang = "en-US";
    /** @type {string} */
    this._fullText = "";
    /** @type {number} */
    this._rate = 1.0;
    /** @type {boolean} */
    this._stopped = true;
    /** @type {boolean} */
    this._sessionActive = false;
    /** @type {boolean} */
    this._firedStart = false;
    /** @type {number} */
    this._playbackToken = 0;
    /** @type {boolean} */
    this._useElevenLabs = false;
    /** @type {string} */
    this._voiceId = ELEVENLABS_VOICES[0].id;
    /** @type {string} */
    this._apiKey = "";
    /** @type {AudioContext | null} */
    this._audioContext = null;
    /** @type {AudioBufferSourceNode | null} */
    this._activeSource = null;
    /** @type {number} */
    this._chunkStartCtxTime = 0;
    /** @type {AudioBuffer | null} */
    this._currentBuffer = null;
    /** @type {(AudioBuffer | null)[]} */
    this._decodedBuffers = [];
    /** @type {ReturnType<typeof setInterval> | null} */
    this._progressTimer = null;
    /** @type {number | null} */
    this._tabId = null;
    /** @type {boolean} */
    this._dyslexiaMode = false;
    /** @type {boolean} */
    this._dyslexiaInPopup = false;
  }

  /**
   * @param {string} sentence
   */
  _sendSentenceHighlight(sentence) {
    if (this._tabId == null) return;
    const s = String(sentence || "").trim();
    if (!s) return;
    if (typeof chrome === "undefined") return;
    if (this._dyslexiaMode && this._dyslexiaInPopup) {
      void chrome.runtime
        .sendMessage({
          type: "LISTENMODE_DYSLEXIA_UI",
          action: "highlight",
          index: this._currentIndex
        })
        .catch(() => {});
      return;
    }
    if (!chrome.tabs?.sendMessage) return;
    if (this._dyslexiaMode) {
      void chrome.tabs
        .sendMessage(this._tabId, {
          action: "dyslexiaOverlayHighlight",
          index: this._currentIndex
        })
        .catch(() => {});
      return;
    }
    void chrome.tabs.sendMessage(this._tabId, {
      action: "highlightSentence",
      sentence: s
    }).catch(() => {
      /* tab closed or content script not injected */
    });
  }

  _clearPageHighlights() {
    if (typeof chrome === "undefined") return;
    if (this._dyslexiaMode && this._dyslexiaInPopup) {
      void chrome.runtime
        .sendMessage({ type: "LISTENMODE_DYSLEXIA_UI", action: "hide" })
        .catch(() => {});
      return;
    }
    if (this._tabId == null) return;
    if (!chrome.tabs?.sendMessage) return;
    if (this._dyslexiaMode) {
      void chrome.tabs.sendMessage(this._tabId, { action: "dyslexiaOverlayHide" }).catch(() => {});
      return;
    }
    void chrome.tabs.sendMessage(this._tabId, { action: "clearHighlights" }).catch(() => {});
  }

  _showDyslexiaOverlay() {
    if (!this._dyslexiaMode || !this._chunks.length) return;
    if (typeof chrome === "undefined") return;
    if (this._dyslexiaInPopup) {
      void chrome.runtime
        .sendMessage({
          type: "LISTENMODE_DYSLEXIA_UI",
          action: "show",
          sentences: this._chunks
        })
        .catch(() => {});
      return;
    }
    if (this._tabId == null) return;
    if (!chrome.tabs?.sendMessage) return;
    void chrome.tabs
      .sendMessage(this._tabId, {
        action: "showDyslexiaOverlay",
        sentences: this._chunks
      })
      .catch(() => {});
  }

  /**
   * @param {string} text
   * @param {string} language
   * @param {{ apiKey?: string, voiceId?: string, tabId?: number, sentences?: string[] }} [options]
   */
  play(text, language, options = {}) {
    this.stop();

    const rawKey = String(options.apiKey || "").trim();
    const vid = String(options.voiceId || ELEVENLABS_VOICES[0].id).trim();
    const useEl = !!rawKey;
    const tid = options.tabId;
    this._tabId =
      tid != null && Number.isFinite(Number(tid)) ? Number(tid) : null;

    this._fullText = String(text || "");
    this._dyslexiaMode = !!options.dyslexiaMode;
    this._dyslexiaInPopup = !!(options.dyslexiaInPopup && this._dyslexiaMode);
    this._lang = langCodeToBcp47(language);
    const sentencesOpt = Array.isArray(options.sentences)
      ? options.sentences.map((s) => String(s).trim()).filter(Boolean)
      : [];
    this._chunks =
      sentencesOpt.length > 0
        ? sentencesOpt
        : splitIntoSentenceChunks(this._fullText);
    this._chunkWordCounts = this._chunks.map(
      (c) => c.split(/\s+/).filter(Boolean).length
    );
    let charAcc = 0;
    this._chunkStartChar = this._chunks.map((c) => {
      const start = charAcc;
      charAcc += c.length;
      return start;
    });

    if (this._chunks.length === 0) {
      return;
    }

    this._showDyslexiaOverlay();

    this._stopped = false;
    this._sessionActive = true;
    this._firedStart = false;
    this._currentIndex = 0;
    this._emitProgress(0, 0);

    if (useEl) {
      this._useElevenLabs = true;
      this._apiKey = rawKey;
      this._voiceId = vid;
      this._decodedBuffers = this._chunks.map(() => null);
      void this._playElevenLabsWithFallback();
    } else {
      this._useElevenLabs = false;
      this._speakChunk();
    }
  }

  /**
   * @param {unknown} e
   * @returns {boolean}
   */
  _isElevenLabsUnauthorized(e) {
    return /** @type {{ status?: number }} */ (e)?.status === 401;
  }

  /**
   * @param {number} token
   */
  _handleElevenLabs401(token) {
    if (token !== this._playbackToken) return;
    this._clearProgressTimer();
    this._clearPageHighlights();
    try {
      this._activeSource?.stop(0);
    } catch {
      /* ignore */
    }
    this._activeSource = null;
    this._currentBuffer = null;
    this._teardownElevenLabs(true, true);
    this._useElevenLabs = false;
    this._sessionActive = false;
    this._stopped = true;
    this._firedStart = false;
    this.dispatchEvent(
      new CustomEvent("playback-error", { detail: { code: "ELEVENLABS_401" } })
    );
    this.dispatchEvent(new CustomEvent("end"));
  }

  /**
   * If ElevenLabs fails, fall back to Web Speech without surfacing an error.
   */
  async _playElevenLabsWithFallback() {
    const token = this._playbackToken;
    try {
      await this._runElevenLabsPlayback(token);
    } catch (e) {
      if (this._isElevenLabsUnauthorized(e)) {
        this._handleElevenLabs401(token);
        return;
      }
      this._onElevenLabsFailure(token);
    }
  }

  /**
   * @param {number} token
   */
  _onElevenLabsFailure(token) {
    if (token !== this._playbackToken) return;
    this._teardownElevenLabs(true, true);
    this._useElevenLabs = false;
    if (this._stopped || !this._sessionActive) return;
    if (typeof speechSynthesis === "undefined") {
      this._finishSession();
      return;
    }
    this._firedStart = false;
    this._currentIndex = 0;
    this._emitProgress(0, 0);
    this._speakChunk();
  }

  /**
   * @param {number} token
   */
  async _runElevenLabsPlayback(token) {
    const ctx = this._ensureContext();
    await ctx.resume();

    await this._decodeChunkAtIndex(0);
    if (token !== this._playbackToken || !this._sessionActive || this._stopped) return;

    if (this._chunks.length > 1) {
      void this._prefetchRemainingChunks(token);
    }

    await this._playDecodedChunkFromIndex(token);
  }

  /**
   * @param {number} idx
   */
  async _decodeChunkAtIndex(idx) {
    const ctx = this._ensureContext();
    const blob = await generateElevenLabsAudio(
      this._chunks[idx],
      this._voiceId,
      this._apiKey
    );
    const ab = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab.slice(0));
    this._decodedBuffers[idx] = buf;
  }

  /**
   * @param {number} token
   */
  async _prefetchRemainingChunks(token) {
    const jobs = [];
    for (let i = 1; i < this._chunks.length; i++) {
      jobs.push(
        this._decodeChunkAtIndex(i).catch(() => {
          /* failure handled when chunk is needed */
        })
      );
    }
    await Promise.all(jobs);
    if (token !== this._playbackToken) return;
  }

  _ensureContext() {
    if (!this._audioContext || this._audioContext.state === "closed") {
      const g = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : {};
      const Ctx = g.AudioContext || g.webkitAudioContext;
      if (!Ctx) {
        throw new Error("AudioContext not available");
      }
      this._audioContext = new Ctx();
    }
    return this._audioContext;
  }

  /**
   * @param {number} token
   */
  async _playDecodedChunkFromIndex(token) {
    if (token !== this._playbackToken) return;
    if (!this._sessionActive || this._stopped) return;

    if (this._currentIndex >= this._chunks.length) {
      this._finishElevenLabsSession();
      return;
    }

    const ctx = this._ensureContext();
    await ctx.resume();

    if (!this._decodedBuffers[this._currentIndex]) {
      try {
        await this._decodeChunkAtIndex(this._currentIndex);
      } catch (e) {
        if (this._isElevenLabsUnauthorized(e)) {
          throw e;
        }
        throw new Error("ElevenLabs decode failed");
      }
    }

    const buf = this._decodedBuffers[this._currentIndex];
    if (!buf) {
      this._finishElevenLabsSession();
      return;
    }

    this._currentBuffer = buf;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this._rate;
    src.connect(ctx.destination);

    this._activeSource = src;
    this._chunkStartCtxTime = ctx.currentTime;

    src.onended = () => {
      if (token !== this._playbackToken) return;
      if (this._stopped || !this._sessionActive) return;
      this._activeSource = null;
      this._currentBuffer = null;
      this._currentIndex += 1;
      if (this._currentIndex >= this._chunks.length) {
        this._finishElevenLabsSession();
        return;
      }
      void this._playDecodedChunkFromIndex(token).catch((e) => {
        if (this._isElevenLabsUnauthorized(e)) {
          this._handleElevenLabs401(token);
          return;
        }
        this._onElevenLabsFailure(token);
      });
    };

    if (!this._firedStart) {
      this._firedStart = true;
      this.dispatchEvent(new CustomEvent("start"));
    }

    const sentenceNow = this._chunks[this._currentIndex] || "";
    this._sendSentenceHighlight(sentenceNow);

    src.start(0);
    this._startProgressTimer();
  }

  _startProgressTimer() {
    this._clearProgressTimer();
    this._progressTimer = setInterval(() => {
      if (!this._sessionActive || this._stopped || !this._useElevenLabs) {
        this._clearProgressTimer();
        return;
      }
      const { charIndex, percentage } = this._computeElevenProgress();
      this.dispatchEvent(
        new CustomEvent("progress", {
          detail: { charIndex, percentage }
        })
      );
    }, 250);
  }

  _clearProgressTimer() {
    if (this._progressTimer != null) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
  }

  _computeElevenProgress() {
    const totalChars = Math.max(1, this._fullText.length);
    const ctx = this._audioContext;
    const buf = this._currentBuffer;
    const chunkIdx = this._currentIndex;
    const chunkText = this._chunks[chunkIdx] || "";
    const baseChar = this._chunkStartChar[chunkIdx] ?? 0;

    if (!ctx || chunkIdx >= this._chunks.length) {
      const p = 100;
      return { charIndex: totalChars, percentage: p };
    }

    if (!buf) {
      const p = Math.min(
        100,
        Math.round((chunkIdx / Math.max(1, this._chunks.length)) * 100)
      );
      const ci = Math.min(totalChars, Math.round((p / 100) * totalChars));
      return { charIndex: ci, percentage: p };
    }

    let frac = 0;
    if (this._activeSource) {
      const dt = ctx.currentTime - this._chunkStartCtxTime;
      const playedInChunk = Math.min(buf.duration, Math.max(0, dt * this._rate));
      frac = buf.duration > 0 ? playedInChunk / buf.duration : 0;
    }

    const charInChunk = Math.floor(frac * chunkText.length);
    const charIndex = Math.min(totalChars, baseChar + charInChunk);
    const percentage = Math.min(100, Math.round((charIndex / totalChars) * 100));
    return { charIndex, percentage };
  }

  _finishElevenLabsSession() {
    this._clearProgressTimer();
    this._activeSource = null;
    this._currentBuffer = null;
    this._clearPageHighlights();
    const totalChars = this._fullText.length;
    this.dispatchEvent(
      new CustomEvent("progress", {
        detail: { charIndex: totalChars, percentage: 100 }
      })
    );
    this._emitProgress(100, totalChars);
    this._sessionActive = false;
    this._stopped = true;
    this.dispatchEvent(new CustomEvent("end"));
  }

  _finishSession() {
    this._clearPageHighlights();
    this._sessionActive = false;
    this._stopped = true;
    this.dispatchEvent(new CustomEvent("end"));
  }

  /**
   * @param {boolean} closeContext
   * @param {boolean} clearDecoded
   */
  _teardownElevenLabs(closeContext, clearDecoded) {
    this._clearProgressTimer();
    try {
      this._activeSource?.stop(0);
    } catch {
      /* ignore */
    }
    this._activeSource = null;
    this._currentBuffer = null;
    if (clearDecoded) {
      this._decodedBuffers = [];
    }
    if (closeContext && this._audioContext && this._audioContext.state !== "closed") {
      void this._audioContext.close();
    }
    if (closeContext) {
      this._audioContext = null;
    }
  }

  pause() {
    if (this._stopped || !this._sessionActive) return;

    if (this._useElevenLabs && this._audioContext) {
      void this._audioContext.suspend();
    } else if (typeof speechSynthesis !== "undefined") {
      try {
        speechSynthesis.pause();
      } catch {
        /* ignore */
      }
    }
    this.dispatchEvent(new CustomEvent("pause"));
  }

  resume() {
    if (this._stopped || !this._sessionActive) return;

    if (this._useElevenLabs && this._audioContext) {
      void this._audioContext.resume();
    } else if (typeof speechSynthesis !== "undefined") {
      try {
        speechSynthesis.resume();
      } catch {
        /* ignore */
      }
    }
    this.dispatchEvent(new CustomEvent("resume"));
  }

  /**
   * @param {number} [seconds=5]
   */
  rewind(seconds = 5) {
    if (!this._chunks.length || this._stopped) return;

    const targetWords = Math.ceil(seconds * WORDS_PER_SEC);

    if (this._useElevenLabs) {
      this._playbackToken += 1;
      this._teardownElevenLabs(false, false);

      let idx = this._currentIndex;
      let need = targetWords;
      while (idx > 0 && need > 0) {
        idx -= 1;
        need -= this._chunkWordCounts[idx] || 0;
      }
      this._currentIndex = Math.max(0, idx);

      if (!this._stopped && this._sessionActive) {
        void this._resumeElevenAfterRewind();
      }
      return;
    }

    if (typeof speechSynthesis === "undefined") return;

    const wasActive = this._sessionActive;
    this._playbackToken += 1;
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }

    let idx = this._currentIndex;
    let need = targetWords;
    while (idx > 0 && need > 0) {
      idx -= 1;
      need -= this._chunkWordCounts[idx] || 0;
    }
    this._currentIndex = Math.max(0, idx);

    if (wasActive && !this._stopped) {
      this._speakChunk();
    }
  }

  async _resumeElevenAfterRewind() {
    const token = this._playbackToken;
    try {
      const ctx = this._ensureContext();
      await ctx.resume();
      await this._playDecodedChunkFromIndex(token);
    } catch (e) {
      if (this._isElevenLabsUnauthorized(e)) {
        this._handleElevenLabs401(token);
        return;
      }
      this._onElevenLabsFailure(token);
    }
  }

  /**
   * @param {number} rate
   */
  setSpeed(rate) {
    const r = Number(rate);
    if (Number.isNaN(r)) return;
    this._rate = Math.min(2, Math.max(0.5, r));
    if (this._activeSource) {
      this._activeSource.playbackRate.value = this._rate;
    }
  }

  stop() {
    this._playbackToken += 1;
    this._clearPageHighlights();

    if (this._useElevenLabs) {
      this._teardownElevenLabs(true, true);
    } else if (typeof speechSynthesis !== "undefined") {
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }

    this._chunks = [];
    this._chunkWordCounts = [];
    this._chunkStartChar = [];
    this._fullText = "";
    this._currentIndex = 0;
    this._stopped = true;
    this._sessionActive = false;
    this._firedStart = false;
    this._useElevenLabs = false;
    this._tabId = null;
    this._dyslexiaMode = false;
    this._dyslexiaInPopup = false;
  }

  /**
   * Pause state for UI (speech vs ElevenLabs).
   * @returns {boolean}
   */
  isPlaybackPaused() {
    if (this._useElevenLabs && this._audioContext) {
      return this._audioContext.state === "suspended";
    }
    return typeof speechSynthesis !== "undefined" && speechSynthesis.paused;
  }

  /**
   * Snapshot for popup / offscreen bridge (session active and pause flag).
   * @returns {{ playing: boolean, paused: boolean }}
   */
  getPlaybackState() {
    return {
      playing: this._sessionActive && !this._stopped,
      paused: this.isPlaybackPaused()
    };
  }

  /**
   * @param {number} percent
   * @param {number} [charIndex]
   */
  _emitProgress(percent, charIndex) {
    const p = Math.min(100, Math.max(0, Math.round(percent)));
    const total = this._fullText.length;
    const ci =
      charIndex != null
        ? Math.min(total, Math.max(0, Math.round(charIndex)))
        : Math.min(total, Math.round((p / 100) * total));
    this.dispatchEvent(
      new CustomEvent("progress", { detail: { percent: p, charIndex: ci } })
    );
  }

  _speakChunk() {
    if (typeof speechSynthesis === "undefined") return;
    if (this._stopped || !this._sessionActive) return;

    if (this._currentIndex >= this._chunks.length) {
      this._clearPageHighlights();
      this._emitProgress(100, this._fullText.length);
      this._sessionActive = false;
      this._stopped = true;
      this.dispatchEvent(new CustomEvent("end"));
      return;
    }

    const token = this._playbackToken;
    const text = this._chunks[this._currentIndex];
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this._lang;
    u.rate = this._rate;

    u.onstart = () => {
      if (token !== this._playbackToken) return;
      if (!this._firedStart) {
        this._firedStart = true;
        this.dispatchEvent(new CustomEvent("start"));
      }
      this._sendSentenceHighlight(text);
      const total = this._chunks.length;
      const pct = total ? (this._currentIndex / total) * 100 : 0;
      const ci = this._chunkStartChar[this._currentIndex] ?? 0;
      this._emitProgress(pct, ci);
    };

    u.onend = () => {
      if (token !== this._playbackToken) return;
      if (this._stopped || !this._sessionActive) return;
      this._currentIndex += 1;
      const total = this._chunks.length;
      const pct = total ? (this._currentIndex / total) * 100 : 100;
      const ci =
        this._currentIndex >= total
          ? this._fullText.length
          : this._chunkStartChar[this._currentIndex] ?? Math.round((pct / 100) * this._fullText.length);
      this._emitProgress(pct, ci);
      this._speakChunk();
    };

    u.onerror = () => {
      if (token !== this._playbackToken) return;
      if (this._stopped || !this._sessionActive) return;
      this._currentIndex += 1;
      this._speakChunk();
    };

    speechSynthesis.speak(u);
  }
}
