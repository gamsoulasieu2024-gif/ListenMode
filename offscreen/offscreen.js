import AudioPlayer from "../utils/audio.js";

const player = new AudioPlayer();

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
      if (cmd === "pause") player.pause();
      else if (cmd === "resume") player.resume();
      else if (cmd === "stop") {
        player.stop();
        activeTabId = null;
      } else if (cmd === "rewind") player.rewind(Number(msg.seconds) || 5);
      else if (cmd === "setSpeed") player.setSpeed(Number(msg.rate));
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (msg?.type === "LISTENMODE_OFFSCREEN_GET_STATE") {
    const s = player.getPlaybackState();
    sendResponse({ ok: true, ...s });
    return true;
  }

  return false;
});

void chrome.runtime.sendMessage({ type: "LISTENMODE_OFFSCREEN_READY" });
