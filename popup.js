const scanButton = document.querySelector("#scanButton");
const batchScanButton = document.querySelector("#batchScanButton");
const downloadButton = document.querySelector("#downloadButton");
const resultPanel = document.querySelector("#result");
const courseTitle = document.querySelector("#courseTitle");
const mediaType = document.querySelector("#mediaType");
const mediaUrl = document.querySelector("#mediaUrl");
const statusElement = document.querySelector("#status");

let currentJob = null;

function showStatus(message, kind = "info") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

function displayUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "已识别媒体地址";
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法读取当前标签页");
  return tab;
}

async function scanPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-scripts/page-scanner.js"],
  });
  const result = results?.[0]?.result;
  if (!result) throw new Error("无法读取课程页面，请刷新后重试");
  return result;
}

async function networkCandidates(tabId) {
  const response = await chrome.runtime.sendMessage({
    type: "GET_MEDIA_CANDIDATES",
    tabId,
  });
  if (!response?.ok) throw new Error(response?.error || "读取媒体请求失败");
  return response.candidates || [];
}

async function scanCatalog(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["shared/catalog-loader.js"],
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["content-scripts/catalog-scanner.js"],
  });
  const snapshot = results?.[0]?.result;
  if (!snapshot) throw new Error("无法读取专栏目录，请确认当前是小鹅通专栏课程页");
  return snapshot;
}

async function catalogFingerprint(catalog) {
  const canonical = JSON.stringify({
    courseId: catalog.courseId,
    lessons: catalog.lessons.map((lesson) => ({
      lessonId: lesson.lessonId,
      title: lesson.title,
      pageUrl: lesson.pageUrl,
    })),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function jobStore() {
  return XiaoeJobStore.createJobStore({
    session: chrome.storage.session,
    local: chrome.storage.local,
    handleStore: { async delete() {} },
  });
}

async function openBatchRunner(query) {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`batch-runner.html?${query}`),
  });
  window.close();
}

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  downloadButton.disabled = true;
  currentJob = null;
  resultPanel.hidden = true;
  showStatus("正在识别当前页面…");

  try {
    const tab = await activeTab();
    const page = await scanPage(tab.id);
    const captured = await networkCandidates(tab.id);
    const selected = XiaoeMediaUtils.selectBestCandidate([
      ...(page.candidates || []),
      ...captured,
    ]);
    if (!selected) {
      throw new Error("没有发现音视频。请先播放课程 3–5 秒，再点一次识别。");
    }

    currentJob = {
      version: 1,
      tabId: tab.id,
      title: page.title || tab.title || "未命名课程",
      pageUrl: page.pageUrl || tab.url,
      media: selected,
      createdAt: Date.now(),
    };
    courseTitle.textContent = currentJob.title;
    mediaType.textContent = selected.kind === "hls" ? "HLS / M3U8" : selected.extension.toUpperCase();
    mediaUrl.textContent = displayUrl(selected.url);
    resultPanel.hidden = false;
    downloadButton.disabled = false;
    showStatus("已识别。下一步选择保存目录。", "success");
  } catch (error) {
    showStatus(error.message || String(error), "error");
  } finally {
    scanButton.disabled = false;
  }
});

downloadButton.addEventListener("click", async () => {
  if (!currentJob) return;
  downloadButton.disabled = true;
  try {
    const jobId = crypto.randomUUID();
    await chrome.storage.session.set({ [`downloadJob:${jobId}`]: currentJob });
    await chrome.runtime.sendMessage({
      type: "CLEAR_MEDIA_CANDIDATES",
      tabId: currentJob.tabId,
    });
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`downloader.html?jobId=${encodeURIComponent(jobId)}`),
    });
    window.close();
  } catch (error) {
    downloadButton.disabled = false;
    showStatus(error.message || String(error), "error");
  }
});

batchScanButton.addEventListener("click", async () => {
  batchScanButton.disabled = true;
  scanButton.disabled = true;
  downloadButton.disabled = true;
  showStatus("正在读取完整专栏目录…");

  try {
    const tab = await activeTab();
    const snapshot = await scanCatalog(tab.id);
    const catalog = XiaoeCatalog.normalizeCatalogSnapshot(snapshot, tab.url);
    const fingerprint = await catalogFingerprint(catalog);
    const store = jobStore();
    const resume = await store.findResumeJob(catalog.courseId, fingerprint);
    if (resume) {
      showStatus("找到未完成的同一专栏任务，正在恢复…", "success");
      await openBatchRunner(`jobId=${encodeURIComponent(resume.jobId)}`);
      return;
    }

    const draftId = crypto.randomUUID();
    const title = String(tab.title || "未命名小鹅通专栏")
      .replace(/\s*[-_|｜]\s*小鹅通.*$/i, "")
      .trim();
    await store.createDraft({
      version: 1,
      draftId,
      courseId: catalog.courseId,
      fingerprint,
      title,
      total: catalog.total,
      lessons: catalog.lessons,
      sourcePageUrl: tab.url,
      createdAt: Date.now(),
    });
    showStatus(`已识别 ${catalog.total} 节，正在打开批量下载页…`, "success");
    await openBatchRunner(`draftId=${encodeURIComponent(draftId)}`);
  } catch (error) {
    showStatus(error.message || String(error), "error");
    batchScanButton.disabled = false;
    scanButton.disabled = false;
  }
});
