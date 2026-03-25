/**
 * Plain-text shaping for the service worker (LLM context). Page extraction
 * lives in content/content.js so the content script does not need dynamic import().
 */

import * as pdfjsLib from "../libs/pdf.min.mjs";

export const PDF_EXTRACT_CAP = 8000;

export const PDF_EXTRACT_FAIL_MSG =
  "Could not extract PDF text. The file may be scanned or image-based.";

/**
 * URL appears to reference a PDF (path ends with .pdf, including query).
 * @param {string} [url]
 * @returns {boolean}
 */
export function urlLooksLikePdf(url) {
  if (!url || typeof url !== "string") return false;
  const noHash = url.split("#")[0] || "";
  const q = noHash.indexOf("?");
  const base = q >= 0 ? noHash.slice(0, q) : noHash;
  const path = base.toLowerCase();
  return path.endsWith(".pdf") || /\.pdf(\?|#|$)/i.test(url);
}

/**
 * HEAD request to detect application/pdf (best-effort; some origins block HEAD).
 * @param {string} [url]
 * @returns {Promise<boolean>}
 */
export async function probePdfContentType(url) {
  if (!url || typeof url !== "string") return false;
  if (
    url.startsWith("chrome:") ||
    url.startsWith("devtools:") ||
    url.startsWith("chrome-extension:")
  ) {
    return false;
  }
  try {
    /** @type {{ success: boolean, contentType?: string, error?: string }} */
    const out = await chrome.runtime.sendMessage({ action: "fetchURL", url, method: "HEAD" });
    if (!out?.success) return false;
    const ct = String(out.contentType || "").toLowerCase();
    return ct.includes("application/pdf");
  } catch {
    return false;
  }
}

/**
 * Extract plain text from a PDF URL via bundled PDF.js (MV3-safe).
 * @param {string} pdfUrl
 * @returns {Promise<{ title: string, content: string | null, error?: string }>}
 */
export async function extractPDFContent(pdfUrl) {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("libs/pdf.worker.min.mjs");

    const result = await chrome.runtime.sendMessage({
      action: "fetchURL",
      url: pdfUrl
    });
    if (!result?.success) throw new Error(result?.error || "Fetch failed");
    const arrayBuffer = new Uint8Array(result.data || []).buffer;

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = "";
    const maxPages = Math.min(pdf.numPages, 20);

    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(" ");
      fullText += pageText + "\n\n";
    }

    const title = decodeURIComponent(
      (pdfUrl.split("/").pop() || "PDF Document").replace(".pdf", "")
    );

    return {
      title,
      content: fullText.trim().slice(0, PDF_EXTRACT_CAP)
    };
  } catch (err) {
    return {
      title: "PDF Document",
      content: null,
      error: "Could not read PDF: " + String(err?.message || err)
    };
  }
}

/**
 * Turn extracted page text into ordered speakable lines for TTS.
 * @param {{ text?: string, title?: string, sections?: Array<{ type: string, text: string }> }} payload
 * @returns {string[]}
 */
export function sectionsToSpeakLines(payload) {
  if (payload.text?.trim()) {
    return payload.text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const lines = [];
  if (payload.title?.trim()) {
    lines.push(payload.title.trim());
  }
  for (const s of payload.sections || []) {
    const t = (s.text || "").trim();
    if (!t) continue;
    lines.push(t);
  }
  return lines;
}

/**
 * Plain text for LLM input (bounded length).
 * @param {{ text?: string, title?: string, sections?: Array<{ type: string, text: string }> }} payload
 * @param {number} maxChars
 */
export function payloadToContextText(payload, maxChars = 12000) {
  const base = (payload.text || "").trim();
  if (base) {
    if (base.length > maxChars) {
      return base.slice(0, maxChars) + "\n\n[…truncated for length]";
    }
    return base;
  }
  const parts = [];
  if (payload.title?.trim()) {
    parts.push(`Title: ${payload.title.trim()}`);
  }
  for (const s of payload.sections || []) {
    const t = (s.text || "").trim();
    if (!t) continue;
    const label = s.type === "heading" ? "Heading" : "Body";
    parts.push(`${label}: ${t}`);
  }
  let text = parts.join("\n\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n\n[…truncated for length]";
  }
  return text;
}
