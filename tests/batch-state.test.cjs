const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TASK_STATUSES,
  countTaskStates,
  createBatchJob,
  isAttemptCurrent,
  recoverBatchJob,
  sanitizeJobForPersistence,
  startAttempt,
  transitionTask,
} = require("../shared/batch-state.js");

function lessons(count = 3) {
  return Array.from({ length: count }, (_, offset) => ({
    lessonId: `lesson-${offset + 1}`,
    index: offset + 1,
    title: `${offset + 1}. Lesson`,
    pageUrl: `https://example.test/lesson-${offset + 1}`,
  }));
}

test("creates a batch job with explicit pending tasks and accurate counts", () => {
  const job = createBatchJob({
    jobId: "job-1",
    courseId: "course-1",
    fingerprint: "fingerprint-1",
    lessons: lessons(),
  });

  assert.equal(job.jobId, "job-1");
  assert.equal(job.tasks.length, 3);
  assert.deepEqual(job.tasks.map((task) => task.status), ["pending", "pending", "pending"]);
  assert.deepEqual(countTaskStates(job), {
    pending: 3,
    resolving: 0,
    downloading: 0,
    committing: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    conflict: 0,
  });
  assert.deepEqual(TASK_STATUSES, [
    "pending",
    "resolving",
    "downloading",
    "committing",
    "success",
    "skipped",
    "failed",
    "conflict",
  ]);
});

test("manifest-verified lessons start skipped and terminal states are counted", () => {
  const source = lessons(4);
  source[0].manifestVerified = true;
  const job = createBatchJob({ jobId: "job", courseId: "course", fingerprint: "fp", lessons: source });

  let token = startAttempt(job, "lesson-2");
  assert.equal(transitionTask(job, "lesson-2", "downloading", { attemptToken: token }), true);
  assert.equal(transitionTask(job, "lesson-2", "committing", { attemptToken: token }), true);
  assert.equal(transitionTask(job, "lesson-2", "success", { attemptToken: token }), true);

  token = startAttempt(job, "lesson-3");
  assert.equal(transitionTask(job, "lesson-3", "failed", { attemptToken: token }), true);
  assert.equal(transitionTask(job, "lesson-4", "conflict"), true);

  assert.deepEqual(countTaskStates(job), {
    pending: 0,
    resolving: 0,
    downloading: 0,
    committing: 0,
    success: 1,
    skipped: 1,
    failed: 1,
    conflict: 1,
  });
  assert.throws(() => transitionTask(job, "lesson-2", "pending"), /illegal transition/i);
  assert.throws(() => transitionTask(job, "lesson-1", "pending"), /illegal transition/i);
});

test("rejects illegal transitions and stale attempt callbacks", () => {
  const job = createBatchJob({ jobId: "job", courseId: "course", fingerprint: "fp", lessons: lessons(1) });
  assert.throws(() => transitionTask(job, "lesson-1", "success"), /illegal transition/i);

  const firstToken = startAttempt(job, "lesson-1");
  assert.equal(isAttemptCurrent(job, "lesson-1", firstToken), true);
  assert.equal(transitionTask(job, "lesson-1", "pending", { attemptToken: firstToken }), true);
  const secondToken = startAttempt(job, "lesson-1");

  assert.notEqual(secondToken, firstToken);
  assert.equal(transitionTask(job, "lesson-1", "downloading", { attemptToken: firstToken }), false);
  assert.equal(job.tasks[0].status, "resolving");
  assert.equal(isAttemptCurrent(job, "lesson-1", secondToken), true);
});

test("a late callback cannot mutate a task after its attempt was cleared", () => {
  const job = createBatchJob({ jobId: "job", courseId: "course", fingerprint: "fp", lessons: lessons(1) });
  const staleToken = startAttempt(job, "lesson-1");
  transitionTask(job, "lesson-1", "pending", { attemptToken: staleToken });

  assert.equal(transitionTask(job, "lesson-1", "conflict", { attemptToken: staleToken }), false);
  assert.equal(job.tasks[0].status, "pending");
});

test("recovery returns active work to pending while preserving terminal states", () => {
  const job = createBatchJob({ jobId: "job", courseId: "course", fingerprint: "fp", lessons: lessons(7) });
  for (let index = 0; index < 3; index += 1) {
    const task = job.tasks[index];
    const token = startAttempt(job, task.lessonId);
    task.mediaUrl = `https://signed.test/${task.lessonId}`;
    if (index >= 1) transitionTask(job, task.lessonId, "downloading", { attemptToken: token });
    if (index >= 2) transitionTask(job, task.lessonId, "committing", { attemptToken: token });
  }
  let token = startAttempt(job, "lesson-4");
  transitionTask(job, "lesson-4", "downloading", { attemptToken: token });
  transitionTask(job, "lesson-4", "committing", { attemptToken: token });
  transitionTask(job, "lesson-4", "success", { attemptToken: token });
  transitionTask(job, "lesson-5", "conflict");
  token = startAttempt(job, "lesson-6");
  transitionTask(job, "lesson-6", "failed", { attemptToken: token });
  job.tasks[6].status = "skipped";

  const recovered = recoverBatchJob(job);
  assert.deepEqual(recovered.tasks.map((task) => task.status), [
    "pending", "pending", "pending", "success", "conflict", "failed", "skipped",
  ]);
  assert.equal(recovered.tasks.slice(0, 3).every((task) => task.attemptToken === null), true);
  assert.equal(recovered.tasks.every((task) => !("mediaUrl" in task)), true);
  assert.notEqual(recovered, job);
  assert.equal(job.tasks[0].status, "resolving");
});

test("persistent snapshots never contain ephemeral signed media URLs", () => {
  const job = createBatchJob({ jobId: "job", courseId: "course", fingerprint: "fp", lessons: lessons(1) });
  job.tasks[0].mediaUrl = "https://signed.test/secret.mp3";
  const snapshot = sanitizeJobForPersistence(job);

  assert.equal(snapshot.tasks[0].mediaUrl, undefined);
  assert.equal(JSON.stringify(snapshot).includes("signed.test"), false);
});
