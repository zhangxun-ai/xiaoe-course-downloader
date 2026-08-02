const titleElement = document.querySelector("#title");
const summaryElement = document.querySelector("#summary");
const previewElement = document.querySelector("#preview");
const jobPanel = document.querySelector("#jobPanel");
const totalCount = document.querySelector("#totalCount");
const firstLesson = document.querySelector("#firstLesson");
const lastLesson = document.querySelector("#lastLesson");
const validationElement = document.querySelector("#validation");
const countsElement = document.querySelector("#counts");
const messageElement = document.querySelector("#message");
const lessonList = document.querySelector("#lessonList");
const startAllButton = document.querySelector("#startAllButton");
const checkpointButton = document.querySelector("#checkpointButton");
const resumeButton = document.querySelector("#resumeButton");
const stopButton = document.querySelector("#stopButton");
const retryButton = document.querySelector("#retryButton");
const overwriteButton = document.querySelector("#overwriteButton");
const cleanupButton = document.querySelector("#cleanupButton");
const toggleAllButton = document.querySelector("#toggleAllButton");

const directoryStore = XiaoeDirectoryStore.createDirectoryStore();
const jobStore = XiaoeJobStore.createJobStore({
  session: chrome.storage.session,
  local: chrome.storage.local,
  handleStore: directoryStore,
});

const statusLabels = {
  pending: "等待",
  resolving: "解析中",
  downloading: "下载中",
  committing: "写入记录",
  success: "完成",
  skipped: "已跳过",
  failed: "失败",
  conflict: "文件冲突",
};

let currentDraft = null;
let currentJob = null;
let currentCore = null;
let currentDirectory = null;
let runningPromise = null;
let readOnly = false;

function showMessage(message, kind = "info") {
  messageElement.textContent = message;
  messageElement.dataset.kind = kind;
}

function storageValue(area, key) {
  return area.get(key).then((values) => values?.[key]);
}

function renderDraft(draft) {
  currentDraft = draft;
  currentJob = null;
  titleElement.textContent = draft.title || "未命名小鹅通专栏";
  summaryElement.textContent = "目录识别完成。默认选中所有可访问课程，只需选择一次保存目录。";
  previewElement.hidden = false;
  jobPanel.hidden = true;
  totalCount.textContent = String(draft.total ?? draft.lessons.length);
  firstLesson.textContent = draft.lessons[0]?.title || "—";
  lastLesson.textContent = draft.lessons.at(-1)?.title || "—";
  const invalid = draft.lessons.filter((lesson) => !lesson.accessible);
  validationElement.textContent = invalid.length
    ? `${invalid.length} 节缺少可访问链接，已取消选中，不会下载。`
    : "";
  toggleAllButton.hidden = false;
  lessonList.replaceChildren(...draft.lessons.map((lesson) => {
    const item = document.createElement("li");
    item.className = "lesson";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = lesson.accessible !== false;
    checkbox.disabled = lesson.accessible === false;
    checkbox.dataset.lessonId = lesson.lessonId;
    const label = document.createElement("span");
    label.className = "lesson-title";
    label.textContent = lesson.title;
    const state = document.createElement("small");
    state.textContent = lesson.accessible === false ? "无可用链接" : "已选中";
    item.append(checkbox, label, state);
    return item;
  }));
}

function taskProgress(task) {
  if (task.status !== "downloading" || !task.bytesWritten) return "";
  if (task.contentLength > 0) return ` · ${Math.min(100, Math.round(task.bytesWritten / task.contentLength * 100))}%`;
  return ` · ${(task.bytesWritten / 1024 / 1024).toFixed(1)} MB`;
}

function renderJob(job) {
  currentJob = job;
  titleElement.textContent = job.title || currentDraft?.title || "小鹅通批量下载";
  summaryElement.textContent = job.checkpoint
    ? `测试任务 · ${job.tasks.length} 节`
    : `正式任务 · ${job.tasks.length} 节`;
  previewElement.hidden = true;
  jobPanel.hidden = false;
  toggleAllButton.hidden = true;

  const counts = XiaoeBatchState.countTaskStates(job);
  countsElement.replaceChildren(...Object.entries(counts).map(([status, count]) => {
    const element = document.createElement("div");
    element.className = "count";
    element.innerHTML = `<strong>${count}</strong> ${statusLabels[status]}`;
    return element;
  }));
  lessonList.replaceChildren(...job.tasks.map((task) => {
    const item = document.createElement("li");
    item.className = "lesson";
    const marker = document.createElement("span");
    marker.textContent = String(task.lessonNumber ?? task.index ?? task.order ?? "");
    const label = document.createElement("span");
    label.className = "lesson-title";
    label.title = task.error || "";
    label.textContent = task.title;
    const state = document.createElement("span");
    state.className = `status-pill status-${task.status}`;
    state.textContent = `${statusLabels[task.status]}${taskProgress(task)}`;
    item.append(marker, label, state);
    return item;
  }));

  const hasPending = counts.pending > 0;
  const hasFailed = counts.failed > 0;
  const hasConflict = counts.conflict > 0;
  const active = counts.resolving + counts.downloading + counts.committing > 0;
  resumeButton.hidden = !hasPending || active || runningPromise !== null;
  stopButton.hidden = !active && runningPromise === null;
  retryButton.hidden = !hasFailed || runningPromise !== null;
  overwriteButton.hidden = !hasConflict || runningPromise !== null;
  const checkpointFinished = job.checkpoint && !hasPending && !active && runningPromise === null;
  cleanupButton.hidden = !checkpointFinished;
  for (const button of [resumeButton, stopButton, retryButton, overwriteButton, cleanupButton]) {
    button.disabled = readOnly;
  }
}

function selectedDraftLessons() {
  const selected = new Set(
    [...lessonList.querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.dataset.lessonId),
  );
  return currentDraft.lessons.filter((lesson) => selected.has(lesson.lessonId) && lesson.accessible !== false);
}

function persistCurrentJob(snapshot) {
  currentJob = snapshot;
  return snapshot.checkpoint
    ? jobStore.saveCheckpoint(snapshot)
    : jobStore.saveFullJob(snapshot);
}

function createChromeResolver() {
  const adapter = {
    createTab: (options) => chrome.tabs.create(options),
    async clearCandidates(tabId, navigationStartedAt) {
      const response = await chrome.runtime.sendMessage({
        type: "CLEAR_MEDIA_CANDIDATES",
        tabId,
        navigationStartedAt,
      });
      if (!response?.ok) throw new Error(response?.error || "无法清理媒体缓存");
      return response;
    },
    async waitForComplete(tabId, options) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return;
      await new Promise((resolve, reject) => {
        const remaining = Math.max(1, options.deadline - Date.now());
        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error("课程页加载超时"));
        }, remaining);
        function listener(updatedId, changeInfo) {
          if (updatedId !== tabId || changeInfo.status !== "complete") return;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
        chrome.tabs.onUpdated.addListener(listener);
      });
    },
    async scanPage(tabId) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-scripts/page-scanner.js"],
      });
      return results?.[0]?.result || { candidates: [] };
    },
    async getCandidates(tabId, navigationStartedAt) {
      const response = await chrome.runtime.sendMessage({
        type: "GET_MEDIA_CANDIDATES",
        tabId,
        navigationStartedAt,
      });
      if (!response?.ok) throw new Error(response?.error || "无法读取媒体请求");
      return response;
    },
    async closeTab(tabId) {
      try { await chrome.tabs.remove(tabId); } catch {}
    },
  };
  return XiaoeTabResolver.createTabResolver(adapter);
}

function createCore(job) {
  return XiaoeBatchRunnerCore.createBatchRunnerCore({
    job,
    persist: persistCurrentJob,
    saveDirectory: (jobId, handle) => directoryStore.save(jobId, handle),
    resolver: createChromeResolver(),
    files: XiaoeBatchFiles,
    downloader: XiaoeDownloadCore,
    fetchImpl: fetch.bind(globalThis),
    lockManager: navigator.locks,
    onUpdate() { renderJob(job); },
  });
}

async function finishRun(promise) {
  runningPromise = promise;
  renderJob(currentJob);
  try {
    const result = await promise;
    if (result.readOnly) {
      readOnly = true;
      showMessage("同一任务已在另一个页面运行，本页已转为只读。", "error");
    } else if (result.stopped) {
      showMessage("任务已停止，当前下载已安全收尾，未开始项保留为等待。");
    } else if (!result.calibration.passed) {
      showMessage("前三节串行校准未通过，已暂停扩展并发。请检查失败项。", "error");
    } else {
      showMessage("本轮下载已结束。", "success");
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      showMessage("已取消选择目录。");
    } else {
      showMessage(error.message || String(error), "error");
    }
  } finally {
    runningPromise = null;
    if (currentJob) renderJob(currentJob);
  }
}

function startDraft(checkpoint) {
  const chosen = selectedDraftLessons();
  if (!chosen.length) {
    showMessage("请至少选择一节可下载课程。", "error");
    return;
  }
  if (checkpoint && chosen.length < 3) {
    showMessage("测试任务需要至少选中三节可下载课程。", "error");
    return;
  }

  const lessons = checkpoint ? chosen.slice(0, 3) : chosen;
  const job = XiaoeBatchState.createBatchJob({
    jobId: crypto.randomUUID(),
    courseId: currentDraft.courseId,
    fingerprint: currentDraft.fingerprint,
    checkpoint,
    lessons,
  });
  job.title = currentDraft.title;
  currentJob = job;
  currentCore = createCore(job);
  renderJob(job);
  showMessage("请选择一个保存目录。之后所有课程都会自动保存到该目录。");

  const promise = currentCore.startWithDirectoryPicker(() => {
    const picked = window.showDirectoryPicker({ mode: "readwrite" });
    return Promise.resolve(picked).then((handle) => {
      currentDirectory = handle;
      return handle;
    });
  });
  void promise.catch((error) => {
    if (error?.name === "AbortError") {
      currentCore = null;
      currentJob = null;
      renderDraft(currentDraft);
      showMessage("已取消选择目录。");
    }
  });
  void promise.then(() => chrome.storage.session.remove(`batchDraft:${currentDraft.draftId}`)).catch(() => {});
  void finishRun(promise);
}

function loadDirectoryForCurrentJob() {
  const handleId = currentJob.directoryHandleId || currentJob.jobId;
  return directoryStore.load(handleId).then((handle) => {
    if (!handle) throw new Error("保存目录记录已丢失，请重新从专栏页发起任务");
    currentDirectory = handle;
    return handle;
  });
}

function resumeCurrentJob() {
  const loaded = currentDirectory ? Promise.resolve(currentDirectory) : loadDirectoryForCurrentJob();
  void loaded.then((directory) => {
    currentCore ||= createCore(currentJob);
    return finishRun(currentCore.start(directory));
  }).catch((error) => showMessage(error.message || String(error), "error"));
}

startAllButton.addEventListener("click", () => startDraft(false));
checkpointButton.addEventListener("click", () => startDraft(true));
resumeButton.addEventListener("click", resumeCurrentJob);

stopButton.addEventListener("click", () => {
  stopButton.disabled = true;
  void currentCore?.stop().then(() => {
    showMessage("已请求停止，当前文件写入完成后不再派发新任务。");
  }).catch((error) => showMessage(error.message || String(error), "error"));
});

retryButton.addEventListener("click", () => {
  const loaded = currentDirectory ? Promise.resolve(currentDirectory) : loadDirectoryForCurrentJob();
  void loaded.then(async (directory) => {
    currentCore ||= createCore(currentJob);
    await currentCore.resetFailed();
    await finishRun(currentCore.start(directory));
  }).catch((error) => showMessage(error.message || String(error), "error"));
});

overwriteButton.addEventListener("click", () => {
  const loaded = currentDirectory ? Promise.resolve(currentDirectory) : loadDirectoryForCurrentJob();
  void loaded.then(async (directory) => {
    currentCore ||= createCore(currentJob);
    await currentCore.overwriteConflicts(directory);
    await finishRun(currentCore.start(directory));
  }).catch((error) => showMessage(error.message || String(error), "error"));
});

cleanupButton.addEventListener("click", () => {
  cleanupButton.disabled = true;
  void jobStore.deleteJob(currentJob.jobId).then(() => {
    showMessage("测试任务状态和目录授权引用已清理。", "success");
    jobPanel.hidden = true;
    lessonList.replaceChildren();
  }).catch((error) => {
    cleanupButton.disabled = false;
    showMessage(error.message || String(error), "error");
  });
});

toggleAllButton.addEventListener("click", () => {
  const available = [...lessonList.querySelectorAll('input[type="checkbox"]:not(:disabled)')];
  const select = available.some((input) => !input.checked);
  for (const input of available) input.checked = select;
});

async function initialize() {
  try {
    const params = new URLSearchParams(location.search);
    const draftId = params.get("draftId");
    const jobId = params.get("jobId");
    if (draftId) {
      const draft = await storageValue(chrome.storage.session, `batchDraft:${draftId}`);
      if (!draft) throw new Error("批量任务预览已过期，请回到专栏页重新识别");
      renderDraft(draft);
      return;
    }
    if (jobId) {
      const stored = await storageValue(chrome.storage.local, `batchJob:${jobId}`);
      if (!stored) throw new Error("找不到该批量任务");
      const recovered = XiaoeBatchState.recoverBatchJob(stored);
      currentJob = recovered;
      currentCore = createCore(recovered);
      await persistCurrentJob(recovered);
      renderJob(recovered);
      showMessage("任务已恢复。点击“继续任务”会读取之前选择的目录。");
      return;
    }
    throw new Error("缺少批量任务参数");
  } catch (error) {
    titleElement.textContent = "无法打开批量任务";
    showMessage(error.message || String(error), "error");
  }
}

void initialize();
