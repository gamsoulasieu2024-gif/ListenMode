/**
 * Content script: runs in the page (isolated world). Wrapped in an IIFE so
 * re-injection does not redeclare top-level const/let (SyntaxError).
 */
(function initListenModeContent() {
  if (globalThis.__listenModeContentLoaded) {
    return;
  }
  globalThis.__listenModeContentLoaded = true;

  const MAX_EXTRACT_CHARS = 8000;

  const ROOT_SELECTORS = [
    "#mw-content-text",
    ".markdown-body",
    "#readme .markdown-body",
    "#readme",
    "article",
    ".post-content",
    ".entry-content",
    ".theme-doc-markdown",
    ".docs-markdown",
    "main",
    '[role="main"]'
  ];

  const NOISE_SELECTOR = [
    "nav",
    "header",
    "footer",
    "aside",
    "script",
    "style",
    "noscript",
    "iframe",
    ".ad",
    ".ads",
    ".advertisement",
    ".cookie-banner",
    ".popup"
  ].join(", ");

  /**
   * @param {HTMLElement} root
   */
  function stripNoiseFromSubtree(root) {
    const nodes = root.querySelectorAll(NOISE_SELECTOR);
    for (let i = nodes.length - 1; i >= 0; i--) {
      nodes[i].remove();
    }
  }

  function cleanBodyText(raw) {
    return raw
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function normalizeOneLine(s) {
    if (s == null) return "";
    return String(s).replace(/\s+/g, " ").trim();
  }

  function extractAuthorFromDocument() {
    const metaPairs = [
      ['meta[name="author"]', (el) => el.getAttribute("content")],
      ['meta[property="article:author"]', (el) => el.getAttribute("content")],
      ['meta[property="og:article:author"]', (el) => el.getAttribute("content")],
      ['meta[name="twitter:creator"]', (el) => el.getAttribute("content")],
      ['meta[name="sailthru.author"]', (el) => el.getAttribute("content")]
    ];

    for (const [sel, get] of metaPairs) {
      const el = document.querySelector(sel);
      const v = el ? get(/** @type {Element} */ (el)) : "";
      const t = normalizeOneLine(v);
      if (t) return t;
    }

    const itemAuthor =
      document.querySelector('[itemprop="author"] [itemprop="name"]') ||
      document.querySelector('[itemprop="author"]');
    if (itemAuthor) {
      const t = normalizeOneLine(itemAuthor.textContent);
      if (t) return t;
    }

    const bylineSelectors = [
      '[rel="author"]',
      ".byline",
      ".author",
      ".post-author",
      ".entry-author",
      ".article-author"
    ];

    for (const sel of bylineSelectors) {
      const el = document.querySelector(sel);
      const t = normalizeOneLine(el?.textContent);
      if (t && t.length < 200) return t;
    }

    return "";
  }

  const HIGHLIGHT_CLASS = "listenmode-highlight";

  function injectHighlightStyles() {
    if (document.getElementById("listenmode-highlight-styles")) return;
    const el = document.createElement("style");
    el.id = "listenmode-highlight-styles";
    el.textContent = `
.${HIGHLIGHT_CLASS} {
  background: rgba(250, 204, 21, 0.4);
  border-radius: 3px;
  transition: background 0.3s ease;
  box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.6);
}
`;
    (document.head || document.documentElement).appendChild(el);
  }

  /** @type {HTMLElement | null} */
  let lastHighlightSpan = null;

  function unwrapHighlight() {
    const span = lastHighlightSpan;
    if (!span || !span.parentNode) {
      lastHighlightSpan = null;
      return;
    }
    const parent = span.parentNode;
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);
    parent.normalize();
    lastHighlightSpan = null;
  }

  function clearAllHighlights() {
    unwrapHighlight();
    const nodes = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    nodes.forEach((node) => {
      const el = /** @type {HTMLElement} */ (node);
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      parent.removeChild(el);
      parent.normalize();
    });
  }

  /**
   * @param {string} sentence
   * @returns {Range | null}
   */
  function findRangeForSentence(sentence) {
    const q = String(sentence || "").trim();
    if (q.length < 2) return null;

    const words = q.split(/\s+/).filter((w) => w.length > 0);
    const useWords = words.length > 20 ? words.slice(0, 20) : words;
    const pattern = useWords
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      return null;
    }

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        /** @param {Node} node */
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName;
          if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (p.closest(`.${HIGHLIGHT_CLASS}`)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let best = null;
    let bestLen = 0;
    let n = walker.nextNode();
    while (n) {
      const t = n.nodeValue;
      if (t && t.length > 2) {
        const m = t.match(re);
        if (m && m.index !== undefined && m[0].length >= bestLen) {
          best = { node: n, start: m.index, end: m.index + m[0].length };
          bestLen = m[0].length;
        }
      }
      n = walker.nextNode();
    }

    if (!best && useWords.length > 4) {
      return findRangeForSentence(useWords.slice(0, 8).join(" "));
    }

    if (!best) return null;

    const range = document.createRange();
    range.setStart(best.node, best.start);
    range.setEnd(best.node, best.end);
    return range;
  }

  /**
   * @param {string} sentence
   */
  function highlightSentence(sentence) {
    injectHighlightStyles();
    unwrapHighlight();

    const range = findRangeForSentence(sentence);
    if (!range) return;

    try {
      const span = document.createElement("span");
      span.className = HIGHLIGHT_CLASS;
      range.surroundContents(span);
      lastHighlightSpan = span;
      span.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      try {
        const span = document.createElement("span");
        span.className = HIGHLIGHT_CLASS;
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
        lastHighlightSpan = span;
        span.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        /* ignore */
      }
    }
  }

  function extractPageContent() {
    const title = (document.title || "").replace(/\s+/g, " ").trim();

    const author = extractAuthorFromDocument();

    const root =
      ROOT_SELECTORS.map((sel) => document.querySelector(sel)).find(Boolean) ||
      document.body;

    const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
    stripNoiseFromSubtree(clone);

    let body = cleanBodyText(clone.innerText || "");

    let out = title ? `Title: ${title}` : "";
    if (author) {
      out += `${out ? "\n\n" : ""}Author: ${author}`;
    }
    if (body) {
      out += `${out ? "\n\n" : ""}${body}`;
    }

    out = out.trim();
    if (out.length > MAX_EXTRACT_CHARS) {
      out = out.slice(0, MAX_EXTRACT_CHARS).replace(/\s+\S*$/, "").trimEnd();
      if (!out.endsWith("…")) out += "…";
    }

    return out;
  }

  /** @type {HTMLElement | null} */
  let miniPlayerRoot = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let miniEndingTimer = null;
  let miniDragging = false;
  /** @type {{ x: number, y: number, left: number, top: number } | null} */
  let miniDragStart = null;

  function truncateMiniTitle(t) {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    if (s.length <= 24) return s;
    return s.slice(0, 23) + "…";
  }

  function injectMiniPlayerStyles() {
    if (document.getElementById("listenmode-mini-styles")) return;
    const st = document.createElement("style");
    st.id = "listenmode-mini-styles";
    st.textContent = `
#listenmode-mini-player {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 280px;
  height: 56px;
  z-index: 999999;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  box-sizing: border-box;
  border-radius: 999px;
  background: #1a1a1a;
  color: #fff;
  box-shadow: 0 8px 32px rgba(0,0,0,0.45);
  display: flex;
  flex-direction: column;
  overflow: visible;
  user-select: none;
  touch-action: none;
  animation: listenmode-mini-slide-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
#listenmode-mini-player.listenmode-mini-exit {
  animation: listenmode-mini-slide-out 0.4s cubic-bezier(0.4, 0, 1, 1) forwards;
}
@keyframes listenmode-mini-slide-in {
  from {
    transform: translate(24px, 24px);
    opacity: 0;
  }
  to {
    transform: translate(0, 0);
    opacity: 1;
  }
}
@keyframes listenmode-mini-slide-out {
  to {
    transform: translate(24px, 24px);
    opacity: 0;
  }
}
.listenmode-mini-inner {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 0 14px;
  min-height: 0;
}
.listenmode-mini-drag {
  cursor: grab;
}
.listenmode-mini-drag:active {
  cursor: grabbing;
}
.listenmode-mini-wave {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 18px;
  width: 22px;
  flex-shrink: 0;
}
.listenmode-mini-wave span {
  display: block;
  width: 4px;
  border-radius: 2px;
  background: #facc15;
  transform-origin: bottom center;
  animation: listenmode-wave-bar 0.7s ease-in-out infinite;
}
.listenmode-mini-wave span:nth-child(1) { animation-delay: 0s; height: 40%; }
.listenmode-mini-wave span:nth-child(2) { animation-delay: 0.15s; height: 70%; }
.listenmode-mini-wave span:nth-child(3) { animation-delay: 0.3s; height: 55%; }
.listenmode-mini-wave.is-idle span {
  animation: none;
  opacity: 0.35;
  height: 35%;
}
@keyframes listenmode-wave-bar {
  0%, 100% { transform: scaleY(0.45); }
  50% { transform: scaleY(1); }
}
.listenmode-mini-title {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  line-height: 1.25;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.listenmode-mini-btns {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.listenmode-mini-btns button {
  background: transparent;
  border: none;
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 6px 4px;
  border-radius: 6px;
}
.listenmode-mini-btns button:hover {
  background: rgba(255,255,255,0.08);
}
.listenmode-mini-progress {
  height: 3px;
  width: 100%;
  background: rgba(255,255,255,0.12);
  border-radius: 0 0 999px 999px;
  overflow: hidden;
  flex-shrink: 0;
}
.listenmode-mini-progress-fill {
  height: 100%;
  width: 0%;
  background: #facc15;
  border-radius: inherit;
  transition: width 0.2s ease;
}
.listenmode-mini-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: #2a2a2a;
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  z-index: 2;
}
#listenmode-mini-player:hover .listenmode-mini-x {
  opacity: 1;
}
`;
    (document.head || document.documentElement).appendChild(st);
  }

  function removeMiniPlayerFromDom() {
    if (miniEndingTimer != null) {
      clearTimeout(miniEndingTimer);
      miniEndingTimer = null;
    }
    if (miniPlayerRoot?.parentNode) {
      miniPlayerRoot.remove();
    }
    miniPlayerRoot = null;
  }

  function scheduleMiniRemove(delayMs) {
    if (miniEndingTimer != null) clearTimeout(miniEndingTimer);
    miniEndingTimer = setTimeout(() => {
      miniEndingTimer = null;
      if (!miniPlayerRoot) return;
      miniPlayerRoot.classList.add("listenmode-mini-exit");
      const t = setTimeout(() => {
        removeMiniPlayerFromDom();
      }, 420);
      /** keep t for gc */
      void t;
    }, delayMs);
  }

  function removeMiniPlayerImmediate() {
    if (!miniPlayerRoot) return;
    miniPlayerRoot.classList.add("listenmode-mini-exit");
    setTimeout(() => removeMiniPlayerFromDom(), 420);
  }

  /**
   * @param {string} title
   */
  function ensureMiniPlayer(title) {
    injectMiniPlayerStyles();
    if (miniPlayerRoot?.parentNode) {
      const titleEl = miniPlayerRoot.querySelector(".listenmode-mini-title");
      if (titleEl) titleEl.textContent = truncateMiniTitle(title);
      return;
    }

    const root = document.createElement("div");
    root.id = "listenmode-mini-player";
    root.innerHTML = `
      <button type="button" class="listenmode-mini-x" title="Dismiss" aria-label="Dismiss">×</button>
      <div class="listenmode-mini-inner listenmode-mini-drag">
        <div class="listenmode-mini-wave is-idle" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="listenmode-mini-title"></div>
        <div class="listenmode-mini-btns">
          <button type="button" class="listenmode-mini-rw" title="Rewind 5s">⏮</button>
          <button type="button" class="listenmode-mini-pp" title="Pause">⏸</button>
          <button type="button" class="listenmode-mini-stop" title="Stop">■</button>
        </div>
      </div>
      <div class="listenmode-mini-progress" aria-hidden="true">
        <div class="listenmode-mini-progress-fill"></div>
      </div>
    `;
    document.documentElement.appendChild(root);
    miniPlayerRoot = root;
    const titleEl = root.querySelector(".listenmode-mini-title");
    if (titleEl) titleEl.textContent = truncateMiniTitle(title);

    const wave = root.querySelector(".listenmode-mini-wave");
    const fill = root.querySelector(".listenmode-mini-progress-fill");
    const btnRw = root.querySelector(".listenmode-mini-rw");
    const btnPp = root.querySelector(".listenmode-mini-pp");
    const btnStop = root.querySelector(".listenmode-mini-stop");
    const btnX = root.querySelector(".listenmode-mini-x");
    const dragEl = root.querySelector(".listenmode-mini-drag");

    function sendCtrl(cmd) {
      void chrome.runtime.sendMessage({ type: "LISTENMODE_MINI_CONTROL", cmd });
    }

    btnRw?.addEventListener("click", (e) => {
      e.stopPropagation();
      sendCtrl("rewind");
    });
    btnPp?.addEventListener("click", (e) => {
      e.stopPropagation();
      const paused = root.dataset.paused === "1";
      sendCtrl(paused ? "resume" : "pause");
    });
    btnStop?.addEventListener("click", (e) => {
      e.stopPropagation();
      sendCtrl("stop");
    });
    btnX?.addEventListener("click", (e) => {
      e.stopPropagation();
      sendCtrl("dismiss");
    });

    function onMove(ev) {
      if (!miniDragging || !miniDragStart || !miniPlayerRoot) return;
      const dx = ev.clientX - miniDragStart.x;
      const dy = ev.clientY - miniDragStart.y;
      miniPlayerRoot.style.left = `${miniDragStart.left + dx}px`;
      miniPlayerRoot.style.top = `${miniDragStart.top + dy}px`;
      miniPlayerRoot.style.right = "auto";
      miniPlayerRoot.style.bottom = "auto";
    }
    function onUp() {
      miniDragging = false;
      miniDragStart = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    dragEl?.addEventListener("mousedown", (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      miniDragging = true;
      const r = root.getBoundingClientRect();
      miniDragStart = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      root.style.left = `${r.left}px`;
      root.style.top = `${r.top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  /**
   * @param {number} progress
   * @param {boolean} paused
   * @param {boolean} playing
   */
  function updateMiniState(progress, paused, playing) {
    if (!miniPlayerRoot) return;
    const fill = miniPlayerRoot.querySelector(".listenmode-mini-progress-fill");
    const wave = miniPlayerRoot.querySelector(".listenmode-mini-wave");
    const btnPp = miniPlayerRoot.querySelector(".listenmode-mini-pp");
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    const showWave = playing && !paused;
    wave?.classList.toggle("is-idle", !showWave);
    if (btnPp) {
      btnPp.textContent = paused ? "▶" : "⏸";
      btnPp.title = paused ? "Resume" : "Pause";
    }
    miniPlayerRoot.dataset.paused = paused ? "1" : "0";
  }

  const DYSLEXIA_OVERLAY_ID = "listenmode-dyslexia-overlay";
  const DYSLEXIA_STYLE_ID = "listenmode-dyslexia-styles";

  /** @type {HTMLElement | null} */
  let dyslexiaOverlayRoot = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let dyslexiaEscHandler = null;

  function injectDyslexiaStyles() {
    if (document.getElementById(DYSLEXIA_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = DYSLEXIA_STYLE_ID;
    st.textContent = `
@import url("https://cdn.jsdelivr.net/npm/open-dyslexic@1.0.3/open-dyslexic-regular.css");
@import url("https://fonts.googleapis.com/css2?family=Lexend:wght@400&display=swap");
#${DYSLEXIA_OVERLAY_ID} {
  position: fixed;
  inset: 0;
  z-index: 999990;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.85);
  font-family: "OpenDyslexicRegular", "OpenDyslexic", Lexend, system-ui, sans-serif;
}
#${DYSLEXIA_OVERLAY_ID} .listenmode-dyslexia-exit {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 999991;
  margin: 0;
  padding: 8px 12px;
  font-size: 13px;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  color: #fff;
  background: #2a2a2a;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0,0,0,0.35);
}
#${DYSLEXIA_OVERLAY_ID} .listenmode-dyslexia-exit:hover {
  background: #3a3a3a;
}
#${DYSLEXIA_OVERLAY_ID} .listenmode-dyslexia-card {
  box-sizing: border-box;
  width: 100%;
  max-width: 680px;
  max-height: calc(100vh - 48px);
  padding: 48px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 24px 80px rgba(0,0,0,0.55);
}
#${DYSLEXIA_OVERLAY_ID} .listenmode-dyslexia-inner {
  box-sizing: border-box;
  max-height: calc(100vh - 48px - 96px);
  padding: 32px 36px;
  overflow-y: auto;
  background: #1a1a1a;
  color: #fff;
  border-radius: 8px;
}
#${DYSLEXIA_OVERLAY_ID} .listenmode-dyslexia-sent {
  margin: 0 0 1.25em;
  font-size: 22px;
  line-height: 2;
  letter-spacing: 0.05em;
  word-spacing: 0.1em;
  color: #fff;
  border-radius: 4px;
  transition: background 0.2s ease, color 0.2s ease;
}
#${DYSLEXIA_OVERLAY_ID} .listenmode-dyslexia-sent:last-child {
  margin-bottom: 0;
}
#${DYSLEXIA_OVERLAY_ID} .listenmode-dyslexia-sent.is-active {
  background: #facc15;
  color: #000;
  border-radius: 4px;
  padding: 4px 8px;
  margin-left: -8px;
  margin-right: -8px;
}
`;
    (document.head || document.documentElement).appendChild(st);
  }

  function removeDyslexiaEscListener() {
    if (dyslexiaEscHandler) {
      document.removeEventListener("keydown", dyslexiaEscHandler, true);
      dyslexiaEscHandler = null;
    }
  }

  function teardownDyslexiaOverlay() {
    removeDyslexiaEscListener();
    if (dyslexiaOverlayRoot?.parentNode) {
      dyslexiaOverlayRoot.remove();
    }
    dyslexiaOverlayRoot = null;
  }

  function stopPlaybackFromDyslexiaUi() {
    teardownDyslexiaOverlay();
    void chrome.runtime.sendMessage({ type: "LISTENMODE_AUDIO_CMD", cmd: "stop" });
  }

  /**
   * @param {string[]} sentences
   */
  function showDyslexiaOverlay(sentences) {
    injectDyslexiaStyles();
    clearAllHighlights();
    teardownDyslexiaOverlay();

    const wrap = document.createElement("div");
    wrap.id = DYSLEXIA_OVERLAY_ID;
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Listen script — dyslexia friendly view");

    const exitBtn = document.createElement("button");
    exitBtn.type = "button";
    exitBtn.className = "listenmode-dyslexia-exit";
    exitBtn.textContent = "✕ Exit Dyslexia Mode";
    exitBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      stopPlaybackFromDyslexiaUi();
    });

    const card = document.createElement("div");
    card.className = "listenmode-dyslexia-card";
    const inner = document.createElement("div");
    inner.className = "listenmode-dyslexia-inner";

    const list = Array.isArray(sentences)
      ? sentences.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
    for (let i = 0; i < list.length; i++) {
      const p = document.createElement("p");
      p.className = "listenmode-dyslexia-sent";
      p.dataset.idx = String(i);
      p.textContent = list[i];
      inner.appendChild(p);
    }
    card.appendChild(inner);

    wrap.appendChild(exitBtn);
    wrap.appendChild(card);
    document.documentElement.appendChild(wrap);
    dyslexiaOverlayRoot = wrap;

    dyslexiaEscHandler = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stopPlaybackFromDyslexiaUi();
    };
    document.addEventListener("keydown", dyslexiaEscHandler, true);

    const first = inner.querySelector(".listenmode-dyslexia-sent");
    first?.classList.add("is-active");
    first?.scrollIntoView({ block: "center", behavior: "auto" });
  }

  /**
   * @param {number} index
   */
  function dyslexiaOverlaySetActive(index) {
    if (!dyslexiaOverlayRoot) return;
    const inner = dyslexiaOverlayRoot.querySelector(".listenmode-dyslexia-inner");
    if (!inner) return;
    const paras = inner.querySelectorAll(".listenmode-dyslexia-sent");
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

  /**
   * @param {Record<string, unknown>} msg
   */
  function handleMiniMessage(msg) {
    const action = msg.action;
    if (action === "show") {
      ensureMiniPlayer(String(msg.title || document.title || ""));
      updateMiniState(0, false, true);
    } else if (action === "state") {
      const p = Number(msg.progress) || 0;
      const paused = !!msg.paused;
      const playing = msg.playing !== false;
      if (!miniPlayerRoot) ensureMiniPlayer(String(msg.title || document.title || ""));
      updateMiniState(p, paused, playing);
    } else if (action === "ending") {
      scheduleMiniRemove(3000);
    } else if (action === "remove") {
      removeMiniPlayerImmediate();
    }
  }

  window.addEventListener("pagehide", () => {
    void chrome.runtime.sendMessage({ type: "LISTENMODE_CONTENT_UNLOAD" });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "LISTENMODE_MINI") {
      handleMiniMessage(msg);
      sendResponse({ success: true });
      return true;
    }
    if (msg?.action === "extractContent") {
      try {
        const content = extractPageContent();
        sendResponse({ success: true, content });
      } catch (e) {
        sendResponse({
          success: false,
          error: String(e?.message || e)
        });
      }
      return;
    }

    if (msg?.action === "highlightSentence") {
      try {
        highlightSentence(String(msg.sentence || ""));
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e?.message || e) });
      }
      return;
    }

    if (msg?.action === "clearHighlights") {
      try {
        clearAllHighlights();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e?.message || e) });
      }
      return;
    }

    if (msg?.action === "showDyslexiaOverlay") {
      try {
        const raw = msg.sentences;
        const sents = Array.isArray(raw) ? raw.map((x) => String(x || "")) : [];
        showDyslexiaOverlay(sents);
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e?.message || e) });
      }
      return;
    }

    if (msg?.action === "dyslexiaOverlayHighlight") {
      try {
        dyslexiaOverlaySetActive(Number(msg.index));
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e?.message || e) });
      }
      return;
    }

    if (msg?.action === "dyslexiaOverlayHide") {
      try {
        teardownDyslexiaOverlay();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e?.message || e) });
      }
    }
  });
})();
