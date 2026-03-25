const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_STREAM_MODEL = "gemini-2.0-flash";

/** Gemini API: reduce empty/blocked outputs; see generateContent in this file. */
const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

/**
 * Prepended to user-facing page content so the model never returns an empty reply without intent.
 * @param {string} user
 */
function augmentUserContent(user) {
  return (
    "Summarize the following text clearly. If you cannot summarize it, return the text 'ERROR: Could not process content.' Do not return an empty response.\n\n" +
    String(user || "")
  );
}

/**
 * @param {unknown} data Parsed JSON from :generateContent
 * @returns {string}
 */
function extractTextFromGeminiResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts || !Array.isArray(parts) || parts.length === 0) {
    throw new Error("Gemini returned an empty response. Please try a different page.");
  }
  const joined = parts
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  if (!joined) {
    throw new Error("Gemini returned an empty response. Please try a different page.");
  }
  return joined;
}

export const OUTPUT_LANG_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  zh: "Chinese",
  ar: "Arabic"
};

export function langCodeToOutputName(code) {
  return OUTPUT_LANG_NAMES[code] || OUTPUT_LANG_NAMES.en;
}

/** @type {readonly string[]} */
export const CONTENT_TYPES = [
  "article",
  "documentation",
  "tutorial",
  "opinion",
  "product",
  "forum",
  "research"
];

/** Style hints keyed by detected content type (listen mode). */
export const STYLE_BY_CONTENT_TYPE = {
  article: "Read like a news anchor. Lead with the key fact, then context.",
  documentation:
    "Read like a senior engineer onboarding a teammate. Step by step.",
  tutorial: "Read like a teacher. Emphasize each step clearly before moving on.",
  opinion:
    "Read like a podcast host. Highlight the argument and the counterpoint.",
  product:
    "Read like a product reviewer. Lead with what it does and who it's for.",
  forum:
    "Read like someone summarizing a heated thread. Capture the debate.",
  research:
    "Read like an academic explainer. Define terms, then findings."
};

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeContentType(raw) {
  const m = String(raw || "")
    .toLowerCase()
    .match(
      /\b(article|documentation|tutorial|opinion|product|forum|research)\b/
    );
  return m ? m[1] : "article";
}

/**
 * Classifies page text for listen-mode styling.
 * @param {string} content Raw page text (truncated internally if very long)
 * @returns {Promise<string>} One of CONTENT_TYPES
 */
export async function detectContentType(content) {
  const snippet = String(content || "").slice(0, 12000);
  const system = `You classify web page content into exactly one category.

Reply with exactly one lowercase word, one of: article, documentation, tutorial, opinion, product, forum, research.
No punctuation, no quotes, no explanation—only that single word.`;

  const user = `Page content:\n\n${snippet}`;
  const raw = await generateContent(system, user, 32);
  // Defensive: Gemini sometimes returns fenced code or JSON despite instructions.
  const parsed = safeParseJSON(raw);
  const candidate =
    parsed && typeof parsed === "object"
      ? parsed?.contentType || parsed?.category || parsed?.type
      : null;
  if (typeof candidate === "string" && candidate.trim()) {
    return normalizeContentType(candidate);
  }

  const cleaned = String(raw || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  return normalizeContentType(cleaned);
}

/** @typedef {"basic" | "intermediate" | "advanced"} Complexity */
/** @typedef {"general" | "technical" | "academic"} Audience */

/**
 * @param {unknown} raw
 * @returns {Complexity}
 */
function normalizeComplexity(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (s === "basic" || s === "intermediate" || s === "advanced") return s;
  return "intermediate";
}

/**
 * @param {unknown} raw
 * @returns {Audience}
 */
function normalizeAudience(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (s === "general" || s === "technical" || s === "academic") return s;
  return "general";
}

/**
 * Short JSON-only Gemini call (no augmentUserContent) for classification snippets.
 * @param {string} system
 * @param {string} user
 * @param {number} [maxTokens]
 */
async function generateJsonSnippet(system, user, maxTokens = 80) {
  const apiKey = await getGeminiApiKey();
  const promptText = `${system}\n\n${user}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        safetySettings: GEMINI_SAFETY_SETTINGS,
        generationConfig: {
          temperature: 0.3,
          topP: 0.9,
          maxOutputTokens: Math.min(2048, maxTokens),
          // Prefer official camelCase, keep snake_case for compatibility with clients/docs that still reference it.
          responseMimeType: "application/json",
          response_mime_type: "application/json"
        }
      })
    });
  } catch (err) {
    console.log(
      "[ListenMode] Gemini JSON snippet fetch failed:",
      err?.message || err,
      err
    );
    throw new Error("NETWORK_ERROR");
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.log(
      "[ListenMode] Gemini JSON snippet HTTP error:",
      res.status,
      errText
    );
    throw new Error(friendlyGeminiHttpError(res.status, errText));
  }

  const data = await res.json();
  return extractTextFromGeminiResponse(data);
}

/**
 * Score source text for spoken-script depth (single short Gemini call).
 * @param {string} content Raw page text
 * @returns {Promise<{ complexity: Complexity, audience: Audience }>}
 */
export async function detectDifficulty(content) {
  const snippet = String(content || "").slice(0, 12000);
  const system = `You assess how difficult the SOURCE TEXT is for a listener and who it is written for.

Respond ONLY with a raw JSON object, no markdown, no explanation, no code fences. Exactly this format:
{"complexity":"basic","audience":"general"}

Allowed values:
complexity: basic | intermediate | advanced
audience: general | technical | academic`;

  const user = `Source text:\n\n${snippet}`;
  const rawJson = await generateJsonSnippet(system, user, 50);
  const parsed = safeParseJSON(rawJson);
  // Enhancement-only: never throw here; default silently if parsing fails.
  if (!parsed || typeof parsed !== "object") {
    return { complexity: "intermediate", audience: "general" };
  }
  return {
    complexity: normalizeComplexity(parsed?.complexity),
    audience: normalizeAudience(parsed?.audience)
  };
}

/**
 * Map detected difficulty + audience to a style line for the script prompt.
 * @param {Complexity} complexity
 * @param {Audience} audience
 * @returns {string}
 */
export function styleInstructionFromDifficulty(complexity, audience) {
  const c = normalizeComplexity(complexity);
  const a = normalizeAudience(audience);

  if (c === "basic" && a === "general") {
    return "Use simple words. Short sentences. Like explaining to a curious 14-year-old.";
  }
  if (c === "basic" && a === "technical") {
    return "Use plain language but keep technical terms. Define each one briefly when first mentioned.";
  }
  if (c === "basic" && a === "academic") {
    return "Use simple words and short sentences. Keep formal claims and citations accurate.";
  }
  if (c === "intermediate") {
    return "Balanced explanation. Assume smart reader, no assumed expertise.";
  }
  if (c === "advanced" && a === "technical") {
    return "Keep full technical depth. Don't oversimplify. Use precise language.";
  }
  if (c === "advanced" && a === "academic") {
    return "Preserve academic nuance. Mention methodology and caveats where relevant.";
  }
  if (c === "advanced" && a === "general") {
    return "Retain depth and nuance, but keep jargon to a minimum or define it once in plain terms.";
  }
  return "Balanced explanation. Assume smart reader, no assumed expertise.";
}

/**
 * @returns {Promise<string>}
 */
async function getGeminiApiKey() {
  const { gemini_api_key, openai_api_key } = await chrome.storage.local.get([
    "gemini_api_key",
    "openai_api_key"
  ]);
  let apiKey = (gemini_api_key || "").trim();
  if (!apiKey && (openai_api_key || "").trim()) {
    apiKey = String(openai_api_key).trim();
    await chrome.storage.local.set({ gemini_api_key: apiKey });
    await chrome.storage.local.remove("openai_api_key");
  }
  if (!apiKey) {
    throw new Error("Add your Gemini API key in Settings first.");
  }
  return apiKey;
}

/**
 * @param {number} status
 * @param {string} body
 */
function friendlyGeminiHttpError(status, body) {
  let msg = "";
  let code = "";
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message || "";
    code = String(j?.error?.code || j?.error?.status || "");
  } catch {
    /* ignore */
  }
  if (status === 404) {
    return "Model not found. Check the model name in the extension code.";
  }
  if (status === 401 || status === 403) {
    return "Invalid API key or access denied. Check your key in Settings.";
  }
  if (status === 429) {
    return "Too many requests — wait a moment and retry";
  }
  if (status === 402 || status === 400) {
    if (/quota|billing|payment|RESOURCE_EXHAUSTED/i.test(body || msg || code)) {
      return "Gemini account or quota issue. Check your Google AI account.";
    }
    return "The request couldn’t be completed. Try again.";
  }
  if (status >= 500) {
    return "Gemini is temporarily unavailable. Try again shortly.";
  }
  return `Network error (${status}). Try again.`;
}

/**
 * @param {string} system
 * @param {string} user
 * @param {number} [maxTokens] Capped at 2048 in generationConfig.
 */
async function generateContent(system, user, maxTokens = 1200) {
  const apiKey = await getGeminiApiKey();
  const promptText = `${system}\n\n${augmentUserContent(user)}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        safetySettings: GEMINI_SAFETY_SETTINGS,
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          maxOutputTokens: Math.min(2048, maxTokens)
        }
      })
    });
  } catch (err) {
    console.log(
      "[ListenMode] Gemini fetch failed (network/CSP):",
      err?.message || err,
      err
    );
    throw new Error("NETWORK_ERROR");
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 404) {
      console.log("Model not found - check model name in code.");
    }
    console.log(
      "[ListenMode] Gemini HTTP error:",
      res.status,
      res.statusText,
      errText
    );
    throw new Error(friendlyGeminiHttpError(res.status, errText));
  }

  const data = await res.json();
  return extractTextFromGeminiResponse(data);
}

/**
 * Same as generateContent but does not wrap `user` with augmentUserContent (for Q&A, etc.).
 * @param {string} system
 * @param {string} user
 * @param {number} [maxTokens]
 */
async function generateContentDirect(system, user, maxTokens = 512) {
  const apiKey = await getGeminiApiKey();
  const promptText = `${system}\n\n${user}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        safetySettings: GEMINI_SAFETY_SETTINGS,
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          maxOutputTokens: Math.min(2048, maxTokens)
        }
      })
    });
  } catch (err) {
    console.log(
      "[ListenMode] Gemini fetch failed (network/CSP):",
      err?.message || err,
      err
    );
    throw new Error("NETWORK_ERROR");
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.log(
      "[ListenMode] Gemini HTTP error:",
      res.status,
      res.statusText,
      errText
    );
    throw new Error(friendlyGeminiHttpError(res.status, errText));
  }

  const data = await res.json();
  return extractTextFromGeminiResponse(data);
}

/** Max page context length sent with Ask the Page (chars). */
const ASK_PAGE_MAX_CONTENT_CHARS = 32000;

/**
 * Answer a question using only the provided page text (Gemini).
 * @param {string} question
 * @param {string} content Extracted page context
 * @param {string} language UI language code (e.g. en)
 * @returns {Promise<string>}
 */
export async function askAboutPage(question, content, language) {
  const langName = langCodeToOutputName(language);
  const system = `You are a helpful assistant. Answer questions strictly based on the page content provided. Be concise — max 3 sentences. Respond in ${langName}.`;

  let pageText = String(content || "").trim();
  if (pageText.length > ASK_PAGE_MAX_CONTENT_CHARS) {
    pageText =
      pageText
        .slice(0, ASK_PAGE_MAX_CONTENT_CHARS)
        .replace(/\s+\S*$/, "")
        .trimEnd() + "…";
  }

  const user = `Page content: ${pageText}\n\nQuestion: ${question}`;
  return generateContentDirect(system, user, 512);
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

/**
 * @param {string} raw
 * @returns {Record<string, unknown>}
 */
function parseJsonFromModel(raw) {
  const original = String(raw).trim();
  let t = original;

  // Safety: some models wrap JSON in markdown fences.
  // Strip only when it explicitly declares json to avoid mangling code blocks that aren't JSON.
  if (/^```json\b/i.test(t)) {
    t = t.replace(/^```json\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  }

  try {
    return JSON.parse(t);
  } catch (e) {
    // Fallback: keep raw model text so callers can still display something.
    return { summary: original };
  }
}

function safeParseJSON(text) {
  // Strip markdown code fences if present
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // Extract using regex as fallback
    const complexity = cleaned.match(
      /"complexity"\s*:\s*"(basic|intermediate|advanced)"/i
    )?.[1];
    const audience = cleaned.match(
      /"audience"\s*:\s*"(general|technical|academic)"/i
    )?.[1];

    if (complexity && audience) {
      return { complexity, audience };
    }
    return null;
  }
}

/**
 * @param {string} script
 * @param {unknown} sentencesRaw
 * @returns {{ script: string, sentences: string[], wordTimings: string[] }}
 */
export function finalizeScriptPayload(script, sentencesRaw) {
  const s = String(script || "").replace(/\s+/g, " ").trim();
  let sentences = Array.isArray(sentencesRaw)
    ? sentencesRaw.map((x) => String(x).trim()).filter(Boolean)
    : [];
  if (sentences.length === 0 && s) {
    sentences = splitIntoSentenceChunks(s);
  }
  const wordTimings = sentences.slice();
  return { script: s, sentences, wordTimings };
}

/**
 * JSON response from Gemini (script + sentences for audio chunks / highlighting).
 * @param {string} system
 * @param {string} user
 * @param {number} [maxTokens] Capped at 2048 in generationConfig.
 */
async function generateContentJSON(system, user, maxTokens = 1200) {
  const apiKey = await getGeminiApiKey();
  const promptText = `${system}\n\n${augmentUserContent(user)}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        safetySettings: GEMINI_SAFETY_SETTINGS,
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          maxOutputTokens: Math.min(2048, maxTokens),
          // Prefer official camelCase, keep snake_case for compatibility with clients/docs that still reference it.
          responseMimeType: "application/json",
          response_mime_type: "application/json"
        }
      })
    });
  } catch (err) {
    console.log(
      "[ListenMode] Gemini JSON fetch failed (network/CSP):",
      err?.message || err,
      err
    );
    throw new Error("NETWORK_ERROR");
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.log(
      "[ListenMode] Gemini JSON HTTP error:",
      res.status,
      res.statusText,
      errText
    );
    throw new Error(friendlyGeminiHttpError(res.status, errText));
  }

  const data = await res.json();
  return extractTextFromGeminiResponse(data);
}

/**
 * `language` is a UI language code (e.g. en, es).
 * @param {string} content Raw page text
 * @param {string} language Language code
 * @param {{ forceSimplify?: boolean }} [options] If forceSimplify, skip detection and use basic/general depth.
 * @returns {Promise<{ script: string, contentType: string, sentences: string[], wordTimings: string[], complexity: string, audience: string, simplified: boolean }>}
 */
export async function generateListenScript(content, language, options = {}) {
  const forceSimplify = options.forceSimplify === true;

  /** @type {string} */
  let contentType;
  /** @type {Complexity} */
  let complexity;
  /** @type {Audience} */
  let audience;

  if (forceSimplify) {
    complexity = "basic";
    audience = "general";
    contentType = await detectContentType(content);
  } else {
    const [ct, diff] = await Promise.all([
      detectContentType(content),
      detectDifficulty(content)
    ]);
    contentType = ct;
    complexity = diff.complexity;
    audience = diff.audience;
  }

  const typeStyle =
    STYLE_BY_CONTENT_TYPE[contentType] || STYLE_BY_CONTENT_TYPE.article;
  const depthStyle = styleInstructionFromDifficulty(complexity, audience);

  const langName = langCodeToOutputName(language);
  const system = `You turn web page text into a script meant to be read aloud by text-to-speech.

Return a JSON object with exactly these keys:
- "script": string — the full script as one continuous piece of prose (200–400 words).
- "sentences": string[] — the same script split into spoken chunks in order. Each item is one sentence or short clause the TTS will read as a unit. Joining them with single spaces must recover the script text (same words, same order).

Rules for the script:
- Restructure for listening, not reading: short sentences, clear flow, no dense blocks.
- Use natural spoken transitions where they fit.
- Remove visual formatting: no bullets; numbered lists as prose; no headers; no raw URLs—paraphrase links if needed.
- Conversational, clear, easy to follow when heard.
- Write entirely in ${langName}.

Style for this page (content shape — follow closely):
${typeStyle}

Difficulty adaptation (follow closely):
${depthStyle}

Output valid JSON only. No markdown fences.`;

  const user = `Page content:\n\n${content}`;

  try {
    const rawJson = await generateContentJSON(system, user, 1100);
    const parsed = parseJsonFromModel(rawJson);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.script !== "string" ||
      !parsed.script.trim()
    ) {
      throw new Error("Gemini returned invalid JSON for script.");
    }
    const scriptRaw = parsed?.script;
    const sentencesRaw = parsed?.sentences;
    const { script, sentences, wordTimings } = finalizeScriptPayload(
      String(scriptRaw ?? ""),
      sentencesRaw
    );
    return {
      script,
      contentType,
      sentences,
      wordTimings,
      complexity,
      audience,
      simplified: forceSimplify
    };
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg === "NETWORK_ERROR") throw e;
    console.log("[ListenMode] Listen JSON parse failed, falling back to plain text:", msg);
    const fallbackSystem = `You turn web page text into a script meant to be read aloud by text-to-speech.

Rules:
- Restructure for listening, not reading: short sentences, clear flow, no dense blocks.
- Remove visual formatting: no bullets, numbered lists as prose, no headers, no URLs or link text—paraphrase what links were about if needed.
- Conversational, clear, easy to follow when heard.
- Target length: 200–400 words.
- Write entirely in ${langName}. Output only the script, no title line or preamble.

Style for this page (content shape — follow closely):
${typeStyle}

Difficulty adaptation (follow closely):
${depthStyle}`;

    const script = await generateContent(fallbackSystem, user, 900);
    const { sentences, wordTimings } = finalizeScriptPayload(script, null);
    return {
      script,
      contentType,
      sentences,
      wordTimings,
      complexity,
      audience,
      simplified: forceSimplify
    };
  }
}

/**
 * Build a fast, short spoken script prompt for streaming TTS.
 * "Be concise..." is intentionally included to reduce first-token latency.
 * @param {string} content
 * @param {string} language
 */
function buildStreamListenPrompt(content, language) {
  const langName = langCodeToOutputName(language);
  return `You are a voice narrator reading web content aloud.

Be concise. Maximum 150 words. No introduction, start speaking immediately.
No headings. No bullet characters. No URLs. Short sentences.
Write entirely in ${langName}.

Source text:
${String(content || "")}`;
}

/**
 * Stream a listen script as sentences (yields as they arrive).
 * NOTE: This uses Gemini's streaming endpoint and returns plain text (not JSON).
 *
 * @param {string} content
 * @param {string} language
 * @param {string} [apiKey]
 */
export async function* streamListenScript(content, language, apiKey) {
  const key = String(apiKey || "").trim() || (await getGeminiApiKey());
  const promptText = buildStreamListenPrompt(content, language);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_STREAM_MODEL}:streamGenerateContent?key=${encodeURIComponent(
    key
  )}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        safetySettings: GEMINI_SAFETY_SETTINGS,
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          maxOutputTokens: 450
        }
      })
    });
  } catch (err) {
    console.log("[ListenMode] Gemini stream fetch failed:", err?.message || err, err);
    throw new Error("NETWORK_ERROR");
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(friendlyGeminiHttpError(res.status, errText));
  }

  if (!res.body) {
    // Fallback: no streaming body (shouldn't happen in modern Chrome)
    const data = await res.json().catch(() => null);
    const txt = data ? extractTextFromGeminiResponse(data) : "";
    if (txt.trim()) yield txt.trim();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textAcc = "";
  let sentenceCarry = "";

  const sentenceRegex = /[^.!?]+[.!?]+/g;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Gemini streaming responses often arrive as newline-delimited JSON or SSE-ish "data:" lines.
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line) continue;
      const jsonText = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (jsonText === "[DONE]") continue;

      let obj;
      try {
        obj = JSON.parse(jsonText);
      } catch {
        // If chunk boundaries split JSON, carry it forward.
        buffer = jsonText + "\n" + buffer;
        continue;
      }

      const parts = obj?.candidates?.[0]?.content?.parts;
      const delta = Array.isArray(parts)
        ? parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("")
        : "";
      if (!delta) continue;

      textAcc += delta;

      // Emit complete sentences as soon as we have them.
      let scan = (sentenceCarry + delta).replace(/\s+/g, " ");
      let match;
      let lastIndex = 0;
      while ((match = sentenceRegex.exec(scan)) !== null) {
        const sent = match[0].trim();
        if (sent) yield sent;
        lastIndex = match.index + match[0].length;
      }
      sentenceCarry = scan.slice(lastIndex).trimStart();
    }
  }

  // Flush any remaining buffered line.
  const tail = buffer.trim();
  if (tail) {
    try {
      const obj = JSON.parse(tail.startsWith("data:") ? tail.slice(5).trim() : tail);
      const parts = obj?.candidates?.[0]?.content?.parts;
      const delta = Array.isArray(parts)
        ? parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("")
        : "";
      if (delta) {
        textAcc += delta;
        sentenceCarry = (sentenceCarry + " " + delta).replace(/\s+/g, " ").trim();
      }
    } catch {
      /* ignore */
    }
  }

  if (sentenceCarry.trim()) {
    yield sentenceCarry.trim();
  } else if (textAcc.trim()) {
    yield textAcc.trim();
  }
}

/**
 * @param {string} content Raw page text
 * @param {string} language Language code
 * @param {{ forceSimplify?: boolean }} [options]
 * @returns {Promise<{ script: string, sentences: string[], wordTimings: string[], complexity: string, audience: string, simplified: boolean }>}
 */
export async function generateUnderstandScript(content, language, options = {}) {
  const forceSimplify = options.forceSimplify === true;

  /** @type {Complexity} */
  let complexity;
  /** @type {Audience} */
  let audience;

  if (forceSimplify) {
    complexity = "basic";
    audience = "general";
  } else {
    const diff = await detectDifficulty(content);
    complexity = diff.complexity;
    audience = diff.audience;
  }

  const depthStyle = styleInstructionFromDifficulty(complexity, audience);
  const langName = langCodeToOutputName(language);

  const system = `You explain web page content like a smart friend over coffee.

Return a JSON object with exactly these keys:
- "script": string — the full explanation as continuous prose.
- "sentences": string[] — the same explanation split into spoken chunks in order (one sentence or short paragraph per item). Joining with single spaces must recover the script.

Structure of the explanation:
1. Start with what this page is about in 1–2 short sentences.
2. Then give 3–5 key ideas; explain each simply in plain language.
3. End with one sentence on why this matters or what the reader might do with it.

Tone: warm, clear, not stiff. No markdown, no bullet characters in the strings.
Write entirely in ${langName}.

Difficulty adaptation (follow closely):
${depthStyle}

Output valid JSON only. No markdown fences.`;

  const user = `Page content:\n\n${content}`;

  try {
    const rawJson = await generateContentJSON(system, user, 2200);
    const parsed = parseJsonFromModel(rawJson);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.script !== "string" ||
      !parsed.script.trim()
    ) {
      throw new Error("Gemini returned invalid JSON for script.");
    }
    const { script, sentences, wordTimings } = finalizeScriptPayload(
      String(parsed?.script ?? ""),
      parsed?.sentences
    );
    return {
      script,
      sentences,
      wordTimings,
      complexity,
      audience,
      simplified: forceSimplify
    };
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg === "NETWORK_ERROR") throw e;
    console.log("[ListenMode] Understand JSON parse failed, falling back:", msg);
    const fallbackSystem = `You explain web page content like a smart friend over coffee.

Structure:
1. Start with what this page is about in 1–2 short sentences.
2. Then give 3–5 key ideas; explain each simply in plain language.
3. End with one sentence on why this matters or what the reader might do with it.

Tone: warm, clear, not stiff. No markdown, no bullet characters—use short paragraphs if needed.
Write entirely in ${langName}. Output only the explanation.

Difficulty adaptation (follow closely):
${depthStyle}`;

    const script = await generateContent(fallbackSystem, user, 2000);
    const { sentences, wordTimings } = finalizeScriptPayload(script, null);
    return {
      script,
      sentences,
      wordTimings,
      complexity,
      audience,
      simplified: forceSimplify
    };
  }
}
