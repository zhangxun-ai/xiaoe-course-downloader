(function attachMediaUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.XiaoeMediaUtils = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createMediaUtils() {
  "use strict";

  const DIRECT_EXTENSIONS = new Set([
    "aac",
    "flac",
    "m4a",
    "mov",
    "mp3",
    "mp4",
    "ogg",
    "wav",
    "webm",
  ]);

  const MIME_EXTENSIONS = new Map([
    ["audio/aac", "aac"],
    ["audio/flac", "flac"],
    ["audio/mp4", "m4a"],
    ["audio/mpeg", "mp3"],
    ["audio/ogg", "ogg"],
    ["audio/wav", "wav"],
    ["audio/webm", "webm"],
    ["video/mp4", "mp4"],
    ["video/quicktime", "mov"],
    ["video/webm", "webm"],
  ]);

  const HLS_MIME_TYPES = new Set([
    "application/mpegurl",
    "application/vnd.apple.mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
  ]);

  function normalizedMime(mime) {
    return String(mime || "").split(";", 1)[0].trim().toLowerCase();
  }

  function extensionFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
      return match ? match[1].toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function classifyMediaUrl(url, mime = "") {
    const value = String(url || "").trim();
    if (!value || /^(blob|data):/i.test(value)) {
      return null;
    }

    const extension = extensionFromUrl(value);
    const mimeType = normalizedMime(mime);
    if (extension === "m3u8" || HLS_MIME_TYPES.has(mimeType)) {
      return { kind: "hls", extension: "m3u8" };
    }
    if (extension === "ts" || extension === "m4s") {
      return null;
    }
    if (DIRECT_EXTENSIONS.has(extension)) {
      return { kind: "direct", extension };
    }
    const mimeExtension = MIME_EXTENSIONS.get(mimeType);
    if (mimeExtension) {
      return { kind: "direct", extension: mimeExtension };
    }
    if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
      return { kind: "direct", extension: "bin" };
    }
    return null;
  }

  function inferExtension(candidate) {
    const classification = classifyMediaUrl(candidate?.url, candidate?.mime);
    return classification?.extension || "bin";
  }

  function scoreCandidate(candidate) {
    const classification = classifyMediaUrl(candidate?.url, candidate?.mime);
    if (!classification) {
      return -1;
    }
    let score = classification.kind === "hls" ? 120 : 100;
    if (candidate?.source === "network") score += 15;
    if (candidate?.source === "dom") score += 10;
    if (candidate?.mime) score += 5;
    return score;
  }

  function selectBestCandidate(candidates) {
    const seen = new Set();
    const ranked = [];
    for (const candidate of candidates || []) {
      const url = String(candidate?.url || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const classification = classifyMediaUrl(url, candidate?.mime);
      if (!classification) continue;
      ranked.push({
        ...candidate,
        ...classification,
        url,
        score: scoreCandidate(candidate),
      });
    }
    ranked.sort((left, right) => right.score - left.score);
    return ranked[0] || null;
  }

  function sanitizeFilenamePart(value) {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*：\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[ .]+|[ .]+$/g, "")
      .slice(0, 120)
      .replace(/[ .]+$/g, "");
    return cleaned || "未命名课程";
  }

  function buildFilename(title, extension, ordinal = 1) {
    const number = String(Math.max(1, Number(ordinal) || 1)).padStart(3, "0");
    const safeExtension = String(extension || "bin")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin";
    const safeTitle = sanitizeFilenamePart(title);
    const filenameStem = /^\d{1,3}(?:[.\u3001\uff0e-]\s*|\s+)/.test(safeTitle)
      ? safeTitle
      : `${number}-${safeTitle}`;
    return `${filenameStem}.${safeExtension}`;
  }

  return {
    buildFilename,
    classifyMediaUrl,
    inferExtension,
    sanitizeFilenamePart,
    scoreCandidate,
    selectBestCandidate,
  };
});
