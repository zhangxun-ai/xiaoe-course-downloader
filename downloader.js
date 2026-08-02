const titleElement = document.querySelector("#title");
const summaryElement = document.querySelector("#summary");
const statusElement = document.querySelector("#status");
const detailsElement = document.querySelector("#details");
const progressBar = document.querySelector("#progressBar");
const startButton = document.querySelector("#startButton");

let job = null;

function setStatus(message, kind = "info") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

function setProgress(percent) {
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  progressBar.style.width = `${normalized}%`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function validatedJob(value) {
  if (!value || value.version !== 1) throw new Error("下载任务不存在或版本不兼容");
  if (!value.title || !value.media?.url) throw new Error("下载任务缺少课程或媒体信息");
  if (!["direct", "hls"].includes(value.media.kind)) throw new Error("无法识别媒体类型");
  const url = new URL(value.media.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("媒体地址不是 HTTP(S) URL");
  return value;
}

async function loadJob() {
  const jobId = new URLSearchParams(location.search).get("jobId");
  if (!jobId) throw new Error("链接中没有下载任务编号");
  const key = `downloadJob:${jobId}`;
  const stored = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  return validatedJob(stored[key]);
}

function splitFilename(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? { base: filename.slice(0, dot), extension: filename.slice(dot) }
    : { base: filename, extension: "" };
}

async function createUniqueFile(directoryHandle, desiredFilename) {
  const { base, extension } = splitFilename(desiredFilename);
  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const filename =
      attempt === 1 ? desiredFilename : `${base} (${attempt})${extension}`;
    try {
      await directoryHandle.getFileHandle(filename);
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
      const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
      return { fileHandle, filename };
    }
  }
  throw new Error("目标目录中同名文件过多，请换一个目录后重试");
}

function directProgress(state) {
  detailsElement.textContent = `已写入 ${formatBytes(state.bytesWritten)}`;
  if (state.contentLength > 0) {
    setProgress((state.bytesWritten / state.contentLength) * 100);
  }
}

function hlsProgress(state) {
  detailsElement.textContent = `正在写入分片 ${state.resourceIndex}/${state.resourceCount} · ${formatBytes(state.bytesWritten)}`;
  setProgress((state.resourceIndex / state.resourceCount) * 100);
}

async function startDownload() {
  if (!job) return;
  if (typeof showDirectoryPicker !== "function") {
    throw new Error("当前浏览器不支持选择目录，请使用最新版 Microsoft Edge 或 Chrome");
  }

  const directoryHandle = await showDirectoryPicker({ mode: "readwrite" });
  let extension = XiaoeMediaUtils.inferExtension(job.media);
  let hlsPlan = null;

  if (job.media.kind === "hls") {
    setStatus("正在读取 HLS 播放列表…");
    hlsPlan = await XiaoeDownloadCore.loadHlsPlan(
      job.media.url,
      (url, options) => fetch(url, options),
    );
    extension = hlsPlan.extension;
  }

  const desiredFilename = XiaoeMediaUtils.buildFilename(job.title, extension, 1);
  const { fileHandle, filename } = await createUniqueFile(
    directoryHandle,
    desiredFilename,
  );
  const writable = await fileHandle.createWritable();
  setStatus(`正在下载 ${filename}`);

  let result;
  try {
    result =
      job.media.kind === "hls"
        ? await XiaoeDownloadCore.writeHlsResources(
            hlsPlan.resources,
            (url, options) => fetch(url, options),
            writable,
            hlsProgress,
          )
        : await XiaoeDownloadCore.writeDirectMedia(
            job.media.url,
            (url, options) => fetch(url, options),
            writable,
            directProgress,
          );
  } catch (error) {
    try {
      await directoryHandle.removeEntry(filename);
    } catch {
      // The download error is more useful than a cleanup error.
    }
    throw error;
  }

  setProgress(100);
  setStatus("下载完成", "success");
  detailsElement.textContent = `${filename} · ${formatBytes(result.bytesWritten)}`;
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  setProgress(0);
  detailsElement.textContent = "";
  try {
    await startDownload();
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus("已取消选择目录");
      startButton.disabled = false;
      return;
    }
    setStatus(error.message || String(error), "error");
    startButton.disabled = false;
  }
});

(async () => {
  try {
    job = await loadJob();
    titleElement.textContent = job.title;
    summaryElement.textContent =
      job.media.kind === "hls"
        ? "已识别 HLS / M3U8，将按顺序下载一节课程。"
        : `已识别 ${String(job.media.extension || "媒体").toUpperCase()} 直链，将下载一个文件。`;
    setStatus("任务已就绪，请选择保存目录。", "success");
    startButton.disabled = false;
  } catch (error) {
    titleElement.textContent = "无法读取下载任务";
    setStatus(error.message || String(error), "error");
  }
})();
