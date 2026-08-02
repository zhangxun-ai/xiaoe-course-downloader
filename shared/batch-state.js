(function attachBatchState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XiaoeBatchState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBatchState() {
  "use strict";

  const TASK_STATUSES = Object.freeze([
    "pending",
    "resolving",
    "downloading",
    "committing",
    "success",
    "skipped",
    "failed",
    "conflict",
  ]);

  const LEGAL_TRANSITIONS = Object.freeze({
    pending: new Set(["resolving", "skipped", "conflict"]),
    resolving: new Set(["downloading", "pending", "skipped", "failed", "conflict"]),
    downloading: new Set(["committing", "pending", "skipped", "failed", "conflict"]),
    committing: new Set(["success", "pending", "skipped", "failed", "conflict"]),
    success: new Set(),
    skipped: new Set(),
    failed: new Set(["pending"]),
    conflict: new Set(["pending"]),
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function requireTask(job, lessonId) {
    const task = job?.tasks?.find((candidate) => candidate.lessonId === lessonId);
    if (!task) throw new Error(`Unknown lesson task: ${lessonId}`);
    return task;
  }

  function createBatchJob(input) {
    if (!input?.jobId || !input?.courseId || !input?.fingerprint) {
      throw new Error("Batch job requires jobId, courseId, and fingerprint");
    }
    if (!Array.isArray(input.lessons)) throw new Error("Batch job requires lessons");

    const seen = new Set();
    const tasks = input.lessons.map((lesson) => {
      const lessonId = String(lesson?.lessonId || "").trim();
      if (!lessonId || seen.has(lessonId)) throw new Error(`Invalid or duplicate lesson id: ${lessonId}`);
      seen.add(lessonId);
      return {
        ...clone(lesson),
        lessonId,
        status: lesson.manifestVerified ? "skipped" : "pending",
        attempts: 0,
        attemptToken: null,
        error: null,
      };
    });

    return {
      version: 1,
      jobId: input.jobId,
      courseId: input.courseId,
      fingerprint: input.fingerprint,
      checkpoint: Boolean(input.checkpoint),
      directoryHandleId: input.directoryHandleId || null,
      stopRequested: false,
      tasks,
    };
  }

  function countTaskStates(job) {
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
    for (const task of job?.tasks || []) {
      if (!(task.status in counts)) throw new Error(`Unknown task status: ${task.status}`);
      counts[task.status] += 1;
    }
    return counts;
  }

  function isAttemptCurrent(job, lessonId, attemptToken) {
    const task = requireTask(job, lessonId);
    return Boolean(attemptToken) && task.attemptToken === attemptToken;
  }

  function transitionTask(job, lessonId, nextStatus, options = {}) {
    const task = requireTask(job, lessonId);
    if (!TASK_STATUSES.includes(nextStatus)) throw new Error(`Unknown task status: ${nextStatus}`);

    const tokenWasSupplied = options.attemptToken !== undefined && options.attemptToken !== null;
    if (tokenWasSupplied && options.attemptToken !== task.attemptToken) return false;
    if (task.attemptToken && !tokenWasSupplied) return false;
    if (!LEGAL_TRANSITIONS[task.status]?.has(nextStatus)) {
      throw new Error(`Illegal transition: ${task.status} -> ${nextStatus}`);
    }

    task.status = nextStatus;
    if (options.patch && typeof options.patch === "object") Object.assign(task, clone(options.patch));
    if (nextStatus === "pending" || ["success", "skipped", "failed", "conflict"].includes(nextStatus)) {
      task.attemptToken = null;
      delete task.mediaUrl;
    }
    return true;
  }

  function startAttempt(job, lessonId) {
    const task = requireTask(job, lessonId);
    if (task.status !== "pending") throw new Error(`Cannot start task from ${task.status}`);
    task.attempts = Number(task.attempts || 0) + 1;
    const token = `${job.jobId}:${lessonId}:${task.attempts}`;
    task.attemptToken = token;
    task.error = null;
    delete task.mediaUrl;
    task.status = "resolving";
    return token;
  }

  function sanitizeJobForPersistence(job) {
    const snapshot = clone(job);
    for (const task of snapshot.tasks || []) delete task.mediaUrl;
    return snapshot;
  }

  function recoverBatchJob(job) {
    const recovered = sanitizeJobForPersistence(job);
    recovered.stopRequested = false;
    for (const task of recovered.tasks || []) {
      if (["resolving", "downloading", "committing"].includes(task.status)) {
        task.status = "pending";
        task.attemptToken = null;
      }
    }
    return recovered;
  }

  return {
    TASK_STATUSES,
    countTaskStates,
    createBatchJob,
    isAttemptCurrent,
    recoverBatchJob,
    sanitizeJobForPersistence,
    startAttempt,
    transitionTask,
  };
});
