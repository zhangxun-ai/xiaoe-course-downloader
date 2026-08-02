(function attachBatchRunnerCore(root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(
    isNode ? require("./batch-state.js") : root.XiaoeBatchState,
    isNode ? require("./batch-scheduler.js") : root.XiaoeBatchScheduler,
    isNode ? require("./batch-files.js") : root.XiaoeBatchFiles,
    isNode ? require("./download-core.js") : root.XiaoeDownloadCore,
  );
  if (isNode) module.exports = api;
  if (root) root.XiaoeBatchRunnerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createRunnerModule(
  batchState,
  batchScheduler,
  defaultFiles,
  defaultDownloader,
) {
  "use strict";

  function mediaTypeFor(candidate, extension) {
    const supplied = String(candidate?.mime || "").split(";", 1)[0].trim();
    if (supplied && supplied !== "audio/unknown" && supplied !== "video/unknown") return supplied;
    const values = {
      aac: "audio/aac",
      flac: "audio/flac",
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      ogg: "audio/ogg",
      ts: "video/mp2t",
      wav: "audio/wav",
      webm: "video/webm",
    };
    return values[extension] || "application/octet-stream";
  }

  function createBatchRunnerCore(options) {
    const job = options?.job;
    const resolver = options?.resolver;
    const persist = options?.persist;
    const files = options?.files || defaultFiles;
    const downloader = options?.downloader || defaultDownloader;
    const fetchImpl = options?.fetchImpl || globalThis.fetch?.bind(globalThis);
    const schedulerFactory = options?.schedulerFactory || batchScheduler?.createBatchScheduler;
    const lockManager = options?.lockManager || globalThis.navigator?.locks;
    const saveDirectory = options?.saveDirectory;
    const onUpdate = options?.onUpdate || (() => {});

    if (!job || typeof persist !== "function" || typeof resolver?.resolve !== "function") {
      throw new Error("Batch runner requires job, persist, and resolver");
    }
    if (!batchState || typeof schedulerFactory !== "function" || !files || !downloader || !fetchImpl) {
      throw new Error("Batch runner dependencies are unavailable");
    }

    let scheduler = null;
    let directory = null;
    let running = false;
    let pickerUsed = false;
    const hlsRequestPool = typeof downloader.createRequestPool === "function"
      ? downloader.createRequestPool(5)
      : null;

    async function save() {
      const snapshot = batchState.sanitizeJobForPersistence(job);
      await persist(snapshot);
      onUpdate(snapshot);
    }

    function notify() {
      onUpdate(batchState.sanitizeJobForPersistence(job));
    }

    function applyProgress(task, attemptToken, progress) {
      if (!batchState.isAttemptCurrent(job, task.lessonId, attemptToken)) return false;
      const bytesWritten = Number(progress?.bytesWritten) || 0;
      const contentLength = Number(progress?.contentLength) || 0;
      task.bytesWritten = bytesWritten;
      task.contentLength = contentLength;
      notify();
      return true;
    }

    async function resolveDownloadPlan(task) {
      const candidate = await resolver.resolve(task.pageUrl);
      if (!candidate?.url || !candidate?.kind) throw new Error("未能解析课程媒体");
      task.mediaUrl = candidate.url;
      if (candidate.kind === "hls") {
        const plan = await downloader.loadHlsPlan(candidate.url, fetchImpl);
        return {
          candidate,
          extension: plan.extension,
          mediaType: mediaTypeFor(candidate, plan.extension),
          write(writable, onProgress) {
            return downloader.writeHlsResources(
              plan.resources,
              fetchImpl,
              writable,
              onProgress,
              { close: false, ...(hlsRequestPool ? { requestPool: hlsRequestPool } : {}) },
            );
          },
        };
      }
      return {
        candidate,
        extension: candidate.extension || "bin",
        mediaType: mediaTypeFor(candidate, candidate.extension),
        write(writable, onProgress) {
          return downloader.writeDirectMedia(
            candidate.url,
            fetchImpl,
            writable,
            onProgress,
            { close: false },
          );
        },
      };
    }

    async function runLesson(task, attemptToken) {
      const reconcileOptions = {
        jobId: job.jobId,
        courseId: job.courseId,
        directory,
        lesson: {
          ...task,
          ordinal: task.lessonNumber ?? task.index ?? task.order,
        },
        lockManager,
      };
      const reconciled = await files.reconcileLessonFile?.(reconcileOptions);
      if (reconciled?.status === "skipped") {
        return {
          status: "skipped",
          patch: { filename: reconciled.filename, bytesWritten: reconciled.bytes },
        };
      }
      if (reconciled?.status === "conflict") {
        return {
          status: "conflict",
          patch: { filename: reconciled.filename, existingBytes: reconciled.bytes },
        };
      }

      const plan = await resolveDownloadPlan(task);
      if (!batchState.isAttemptCurrent(job, task.lessonId, attemptToken)) return { status: "failed" };

      const fileLesson = {
        ...task,
        extension: plan.extension,
        ordinal: task.lessonNumber ?? task.index ?? task.order,
        mediaType: plan.mediaType,
      };
      const fileOptions = {
        jobId: job.jobId,
        courseId: job.courseId,
        directory,
        lesson: fileLesson,
        lockManager,
      };
      const prepared = await files.prepareLessonFile(fileOptions);
      if (prepared.status === "skipped") {
        return { status: "skipped", patch: { filename: prepared.filename, bytesWritten: prepared.bytes } };
      }
      if (prepared.status === "conflict") {
        return {
          status: "conflict",
          patch: {
            filename: prepared.filename,
            existingBytes: prepared.bytes,
            extension: plan.extension,
            mediaType: plan.mediaType,
          },
        };
      }

      if (!batchState.transitionTask(job, task.lessonId, "downloading", {
        attemptToken,
        patch: {
          extension: plan.extension,
          mediaType: plan.mediaType,
          filename: prepared.filename,
          bytesWritten: 0,
          contentLength: 0,
        },
      })) {
        return { status: "failed" };
      }
      await save();

      try {
        const committed = await files.commitLessonFile({
          ...fileOptions,
          filename: prepared.filename,
          expectedMediaExtension: plan.extension,
          mediaType: plan.mediaType,
          verified: true,
          write: (writable) => plan.write(
            writable,
            (progress) => applyProgress(task, attemptToken, progress),
          ),
          beforeClose: async ({ bytesWritten, filename }) => {
            if (!batchState.isAttemptCurrent(job, task.lessonId, attemptToken)) {
              const error = new Error("过期的下载回调已忽略");
              error.retryable = false;
              throw error;
            }
            if (!batchState.transitionTask(job, task.lessonId, "committing", {
              attemptToken,
              patch: { bytesWritten, expectedBytes: bytesWritten, filename },
            })) {
              const error = new Error("下载任务状态已失效");
              error.retryable = false;
              throw error;
            }
            await save();
          },
        });
        return {
          status: "success",
          patch: {
            filename: committed.filename,
            bytesWritten: committed.bytes,
            expectedBytes: committed.bytes,
            mediaType: committed.mediaType || plan.mediaType,
          },
        };
      } catch (error) {
        if (/^Conflict:/i.test(error?.message || "")) {
          return { status: "conflict", patch: { filename: prepared.filename } };
        }
        throw error;
      }
    }

    async function runUnlocked(targetDirectory) {
      directory = targetDirectory;
      scheduler = schedulerFactory({
        job,
        runLesson,
        persist: async (snapshot) => {
          await persist(snapshot);
          onUpdate(snapshot);
        },
        maxConcurrency: 2,
        maxRetries: 0,
      });
      running = true;
      try {
        const result = await scheduler.start();
        return { ...result, readOnly: false };
      } finally {
        running = false;
      }
    }

    async function start(targetDirectory) {
      if (!targetDirectory || targetDirectory.kind !== "directory") {
        throw new Error("请选择下载目录");
      }
      if (running) throw new Error("任务正在运行");
      const callback = async (lock) => {
        if (!lock) return { readOnly: true, job };
        return runUnlocked(targetDirectory);
      };
      if (lockManager?.request) {
        return lockManager.request(
          `xiaoe-batch-job:${job.jobId}`,
          { ifAvailable: true },
          callback,
        );
      }
      return callback({ name: `xiaoe-batch-job:${job.jobId}` });
    }

    function startWithDirectoryPicker(pickDirectory) {
      if (pickerUsed) return Promise.reject(new Error("保存目录已经选择"));
      if (typeof pickDirectory !== "function") return Promise.reject(new Error("缺少目录选择器"));
      pickerUsed = true;
      let picked;
      try {
        // This call intentionally happens before the first await to preserve user activation.
        picked = pickDirectory();
      } catch (error) {
        pickerUsed = false;
        return Promise.reject(error);
      }
      const pickedDirectory = Promise.resolve(picked).catch((error) => {
        pickerUsed = false;
        throw error;
      });
      return pickedDirectory.then(async (targetDirectory) => {
        job.directoryHandleId ||= job.jobId;
        if (typeof saveDirectory === "function") {
          await saveDirectory(job.directoryHandleId, targetDirectory);
        }
        await save();
        return start(targetDirectory);
      });
    }

    async function stop() {
      if (!scheduler) {
        job.stopRequested = true;
        await save();
        return;
      }
      await scheduler.stop();
    }

    async function resetFailed() {
      for (const task of job.tasks) {
        if (task.status !== "failed") continue;
        batchState.transitionTask(job, task.lessonId, "pending");
        task.attempts = 0;
        task.attemptToken = null;
        task.error = null;
        task.bytesWritten = 0;
        task.contentLength = 0;
      }
      await save();
    }

    async function overwriteConflicts(targetDirectory = directory) {
      if (!targetDirectory) throw new Error("无法读取下载目录");
      for (const task of job.tasks) {
        if (task.status !== "conflict") continue;
        await files.overwriteConflict({
          jobId: job.jobId,
          courseId: job.courseId,
          directory: targetDirectory,
          lesson: {
            ...task,
            extension: task.extension || "bin",
            ordinal: task.lessonNumber ?? task.index ?? task.order,
          },
          filename: task.filename,
          lockManager,
        });
        batchState.transitionTask(job, task.lessonId, "pending");
      }
      await save();
    }

    return {
      job,
      overwriteConflicts,
      resetFailed,
      start,
      startWithDirectoryPicker,
      stop,
    };
  }

  return { createBatchRunnerCore, mediaTypeFor };
});
