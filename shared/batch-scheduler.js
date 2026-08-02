(function attachBatchScheduler(root, factory) {
  const state =
    typeof module === "object" && module.exports
      ? require("./batch-state.js")
      : root.XiaoeBatchState;
  const api = factory(state);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XiaoeBatchScheduler = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSchedulerModule(state) {
  "use strict";

  function defaultSleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function createBatchScheduler(options) {
    const job = options?.job;
    const runLesson = options?.runLesson;
    const persist = options?.persist;
    if (!job || typeof runLesson !== "function" || typeof persist !== "function") {
      throw new Error("Scheduler requires job, runLesson, and persist");
    }

    const sleep = options.sleep || defaultSleep;
    const maxRetries = options.maxRetries ?? 2;
    const maxConcurrency = options.maxConcurrency ?? 2;
    let started = false;

    async function save() {
      await persist(state.sanitizeJobForPersistence(job));
    }

    async function stop() {
      job.stopRequested = true;
      await save();
    }

    async function finishAttempt(task, token, outcome) {
      const finalStatus = outcome?.status || "success";
      if (finalStatus === "success") {
        if (["success", "skipped"].includes(task.status)) return true;
        const remainingTransitions = {
          resolving: ["downloading", "committing", "success"],
          downloading: ["committing", "success"],
          committing: ["success"],
        }[task.status];
        if (!remainingTransitions || !state.isAttemptCurrent(job, task.lessonId, token)) return false;
        for (const nextStatus of remainingTransitions) {
          const patch = nextStatus === "success" ? outcome?.patch : undefined;
          if (!state.transitionTask(job, task.lessonId, nextStatus, { attemptToken: token, patch })) return false;
          await save();
        }
        return true;
      }
      if (finalStatus === "skipped") {
        if (["success", "skipped"].includes(task.status)) return true;
        if (!state.isAttemptCurrent(job, task.lessonId, token)) return false;
        if (!state.transitionTask(job, task.lessonId, "skipped", { attemptToken: token, patch: outcome?.patch })) return false;
        await save();
        return true;
      }
      if (finalStatus === "conflict") {
        if (task.status === "conflict") return false;
        if (!state.isAttemptCurrent(job, task.lessonId, token)) return false;
        if (!state.transitionTask(job, task.lessonId, "conflict", { attemptToken: token, patch: outcome?.patch })) return false;
        await save();
        return false;
      }
      const error = new Error(outcome?.error || "Lesson failed");
      error.retryable = outcome?.retryable === true;
      throw error;
    }

    async function runTask(task) {
      while (!job.stopRequested && task.status === "pending") {
        const token = state.startAttempt(job, task.lessonId);
        await save();
        try {
          const outcome = await runLesson(task, token);
          return await finishAttempt(task, token, outcome);
        } catch (error) {
          if (!state.isAttemptCurrent(job, task.lessonId, token)) return false;
          const retryable = error?.retryable !== false;
          const retriesUsed = task.attempts - 1;
          if (retryable && retriesUsed < maxRetries && !job.stopRequested) {
            state.transitionTask(job, task.lessonId, "pending", {
              attemptToken: token,
              patch: { error: String(error?.message || error) },
            });
            await save();
            await sleep(Math.min(1_000 * task.attempts, 3_000));
            continue;
          }
          state.transitionTask(job, task.lessonId, "failed", {
            attemptToken: token,
            patch: { error: String(error?.message || error) },
          });
          await save();
          return false;
        }
      }
      return false;
    }

    async function runPool(tasks) {
      let cursor = 0;
      async function worker() {
        while (!job.stopRequested) {
          const task = tasks[cursor];
          if (!task) return;
          cursor += 1;
          await runTask(task);
        }
      }
      const workers = Array.from(
        { length: Math.min(maxConcurrency, tasks.length) },
        () => worker(),
      );
      await Promise.all(workers);
    }

    async function start() {
      if (started) throw new Error("Scheduler has already started");
      started = true;
      job.stopRequested = false;
      const unfinished = job.tasks.filter((task) => task.status === "pending");
      const calibration = {
        required: Math.min(3, unfinished.length),
        successfulSamples: 0,
        passed: unfinished.length === 0,
        failedLessonId: null,
      };

      while (!job.stopRequested && calibration.successfulSamples < 3) {
        const task = job.tasks.find((candidate) => candidate.status === "pending");
        if (!task) break;
        const succeeded = await runTask(task);
        if (!succeeded) {
          if (!job.stopRequested) calibration.failedLessonId = task.lessonId;
          break;
        }
        if (task.status === "success") calibration.successfulSamples += 1;
      }

      if (!job.stopRequested && !calibration.failedLessonId) {
        calibration.passed = true;
        await runPool(job.tasks.filter((task) => task.status === "pending"));
      }

      return { job, calibration, stopped: job.stopRequested };
    }

    return { job, start, stop };
  }

  return { createBatchScheduler };
});
