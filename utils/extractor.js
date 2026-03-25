/**
 * Plain-text shaping for the service worker (LLM context). Page extraction
 * lives in content/content.js so the content script does not need dynamic import().
 */

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
    const r = await fetch(url, { method: "HEAD", credentials: "include" });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    return ct.includes("application/pdf");
  } catch {
    return false;
  }
}

/**
 * Extract plain text from the built-in PDF viewer tab via PDF.js (MAIN world).
 * @param {number} tabId
 * @returns {Promise<{ title: string, content: string }>}
 */
export async function extractPDFContent(tabId) {
  if (tabId == null) throw new Error("No tab for PDF extraction.");

  const grants = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: /** @param {number} m */ async (m) => {
      const pdfjsLib =
        globalThis["pdfjs-dist/build/pdf"] ||
        globalThis["pdfjs-dist/build/pdf.mjs"] ||
        globalThis.pdfjsLib;

      if (!pdfjsLib || typeof pdfjsLib.getDocument !== "function") {
        return {
          ok: false,
          error:
            "Could not extract PDF text. The file may be scanned or image-based."
        };
      }

      const cap = Math.min(Math.max(Number(m) || 8000, 1000), 50000);

      const embed =
        document.querySelector('embed[type="application/pdf"]') ||
        document.querySelector("embed[src]");
      const iframe =
        document.querySelector('iframe[type="application/pdf"]') ||
        document.querySelector('iframe[src*=".pdf"]') ||
        document.querySelector("iframe[src]");

      let pdfUrl = "";
      if (embed?.src) pdfUrl = embed.src;
      else if (iframe?.src) pdfUrl = iframe.src;
      else pdfUrl = globalThis.location?.href || "";

      if (!pdfUrl) {
        return {
          ok: false,
          error:
            "Could not extract PDF text. The file may be scanned or image-based."
        };
      }

      try {
        if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
          const base = globalThis.location?.origin || "";
          if (base) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.js`;
          }
        }
      } catch {
        /* ignore */
      }

      let title = "document.pdf";
      try {
        const u = new URL(pdfUrl, globalThis.location?.href || undefined);
        const segs = u.pathname.split("/").filter(Boolean);
        const leaf = segs.length ? segs[segs.length - 1] : "";
        if (leaf) title = decodeURIComponent(leaf) || title;
      } catch {
        /* default */
      }

      try {
        const loadingTask = pdfjsLib.getDocument({
          url: pdfUrl,
          withCredentials: false
        });
        const pdf = await loadingTask.promise;
        /** @type {string[]} */
        const acc = [];
        let joined = "";
        const numPages = pdf.numPages || 0;
        for (let p = 1; p <= numPages; p++) {
          if (joined.length >= cap) break;
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          let chunk = "";
          for (const item of tc.items) {
            if (item && typeof item === "object" && "str" in item) {
              chunk += /** @type {{ str: string }} */ (item).str;
            }
          }
          acc.push(chunk.replace(/\s+/g, " ").trim());
          joined = acc.join("\n\n");
        }
        let text = acc.join("\n\n").replace(/\s+/g, " ").trim();
        if (text.length > cap) {
          text = text.slice(0, cap).replace(/\s+\S*$/, "").trimEnd();
          if (!text.endsWith("…")) text += "…";
        }
        return { ok: true, title, content: text };
      } catch {
        return {
          ok: false,
          error:
            "Could not extract PDF text. The file may be scanned or image-based."
        };
      }
    },
    args: [PDF_EXTRACT_CAP]
  });

  const raw = grants?.[0]?.result;
  if (!raw || !raw.ok || !String(raw.content || "").trim()) {
    throw new Error((raw && raw.error) || PDF_EXTRACT_FAIL_MSG);
  }
  return {
    title: String(raw.title || "document.pdf"),
    content: String(raw.content || "")
  };
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
