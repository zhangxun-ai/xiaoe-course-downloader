(() => {
  const candidates = [];
  const seen = new Set();
  const directAudio = document.querySelector("audio");

  function addCandidate(url, source, mime = "") {
    try {
      const value = String(url || "").trim();
      if (!value) return;
      const resolved = new URL(value, location.href).href;
      if (!resolved || /^(blob|data):/i.test(resolved) || seen.has(resolved)) return;
      seen.add(resolved);
      candidates.push({ url: resolved, source, mime });
    } catch {
      // Ignore malformed URLs exposed by page widgets.
    }
  }

  addCandidate(
    directAudio?.currentSrc || directAudio?.src || directAudio?.getAttribute("src"),
    "dom",
    "audio/unknown",
  );

  for (const element of document.querySelectorAll("video")) {
    addCandidate(
      element.currentSrc || element.src,
      "dom",
      "video/unknown",
    );
  }
  for (const source of document.querySelectorAll("audio source, video source")) {
    addCandidate(source.src || source.getAttribute("src"), "dom", source.type);
  }
  for (const selector of [
    'meta[property="og:audio"]',
    'meta[property="og:audio:url"]',
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
  ]) {
    const meta = document.querySelector(selector);
    addCandidate(meta?.content, "dom");
  }

  for (const entry of performance.getEntriesByType("resource")) {
    if (
      /\.(m3u8|mp3|m4a|aac|mp4|mov|webm|ogg|wav|flac)(?:$|[?#])/i.test(entry.name) ||
      ["audio", "video"].includes(entry.initiatorType)
    ) {
      addCandidate(entry.name, "performance");
    }
  }

  const titleCandidates = [
    document.querySelector('meta[property="og:title"]')?.content,
    document.querySelector("h1")?.textContent,
    document.querySelector("[class*='lesson'][class*='title']")?.textContent,
    document.title,
  ];
  const title =
    titleCandidates.find((value) => String(value || "").trim())?.trim() ||
    "未命名课程";

  return {
    pageUrl: location.href,
    navigationStartedAt: performance.timeOrigin,
    title: title.replace(/\s*[-_|｜]\s*小鹅通.*$/i, "").trim(),
    candidates: candidates.slice(0, 200),
  };
})();
