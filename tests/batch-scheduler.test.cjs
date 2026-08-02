const test = require("node:test");
const assert = require("node:assert/strict");

const { createBatchJob, transitionTask } = require("../shared/batch-state.js");
const { createBatchScheduler } = require("../shared/batch-scheduler.js");

function makeJob(count, verified = []) {
  return createBatchJob({
    jobId: "job-1",
    courseId: "course-1",
    fingerprint: "fp-1",
    lessons: Array.from({ length: count }, (_, offset) => ({
      lessonId: `lesson-${offset + 1}`,
      index: offset + 1,
      title: `${offset + 1}. Lesson`,
      pageUrl: `https://example.test/${offset + 1}`,
      manifestVerified: verified.includes(offset + 1),
    })),
  });
}

test("runs the first min(3, unfinished) tasks serially, then expands to at most two", async () => {
  const job = makeJob(6, [1]);
  const started = [];
  let active = 0;
  let peak = 0;
  const releases = new Map();
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    runLesson: async (task) => {
      started.push(task.lessonId);
      active += 1;
      peak = Math.max(peak, active);
      if (["lesson-5", "lesson-6"].includes(task.lessonId)) {
        await new Promise((resolve) => releases.set(task.lessonId, resolve));
      }
      active -= 1;
      return { status: "success" };
    },
  });

  const running = scheduler.start();
  for (let turn = 0; turn < 20 && !releases.has("lesson-6"); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(started.slice(0, 3), ["lesson-2", "lesson-3", "lesson-4"]);
  assert.equal(releases.has("lesson-5"), true);
  assert.equal(releases.has("lesson-6"), true);
  assert.equal(peak, 2);
  releases.get("lesson-5")();
  releases.get("lesson-6")();
  await running;
  assert.equal(job.tasks.every((task) => ["success", "skipped"].includes(task.status)), true);
});

test("all manifest-verified jobs finish without calibration or workers", async () => {
  const job = makeJob(3, [1, 2, 3]);
  let calls = 0;
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    runLesson: async () => { calls += 1; },
  });

  const result = await scheduler.start();
  assert.equal(calls, 0);
  assert.equal(result.calibration.required, 0);
  assert.equal(result.calibration.passed, true);
});

test("a calibration failure prevents concurrency expansion", async () => {
  const job = makeJob(5);
  const calls = [];
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    sleep: async () => {},
    runLesson: async (task) => {
      calls.push(task.lessonId);
      if (task.lessonId === "lesson-2") {
        const error = new Error("permanent");
        error.retryable = false;
        throw error;
      }
      return { status: "success" };
    },
  });

  const result = await scheduler.start();
  assert.deepEqual(calls, ["lesson-1", "lesson-2"]);
  assert.equal(result.calibration.passed, false);
  assert.equal(result.calibration.failedLessonId, "lesson-2");
  assert.deepEqual(job.tasks.slice(2).map((task) => task.status), ["pending", "pending", "pending"]);
});

test("stop prevents new dispatch while allowing current work to finish", async () => {
  const job = makeJob(4);
  let release;
  const calls = [];
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    runLesson: async (task) => {
      calls.push(task.lessonId);
      await new Promise((resolve) => { release = resolve; });
      return { status: "success" };
    },
  });

  const running = scheduler.start();
  while (!release) await Promise.resolve();
  await scheduler.stop();
  release();
  const result = await running;

  assert.deepEqual(calls, ["lesson-1"]);
  assert.equal(result.stopped, true);
  assert.equal(job.tasks[1].status, "pending");
});

test("retryable failures discard mediaUrl and stop after two retries", async () => {
  const job = makeJob(1);
  const attemptTokens = [];
  const persisted = [];
  let calls = 0;
  const scheduler = createBatchScheduler({
    job,
    persist: async (snapshot) => persisted.push(snapshot),
    sleep: async () => {},
    runLesson: async (task, attemptToken) => {
      calls += 1;
      attemptTokens.push(attemptToken);
      assert.equal(task.mediaUrl, undefined);
      task.mediaUrl = `https://signed.test/${calls}`;
      const error = new Error("temporary network failure");
      error.retryable = true;
      throw error;
    },
  });

  await scheduler.start();

  assert.equal(calls, 3);
  assert.equal(new Set(attemptTokens).size, 3);
  assert.equal(job.tasks[0].attempts, 3);
  assert.equal(job.tasks[0].status, "failed");
  assert.equal(job.tasks[0].mediaUrl, undefined);
  assert.equal(persisted.every((snapshot) => !JSON.stringify(snapshot).includes("signed.test")), true);
});

test("a retry re-resolves from a blank mediaUrl and can then succeed", async () => {
  const job = makeJob(1);
  let calls = 0;
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    sleep: async () => {},
    runLesson: async (task) => {
      calls += 1;
      assert.equal(task.mediaUrl, undefined);
      if (calls === 1) {
        task.mediaUrl = "https://signed.test/stale";
        const error = new Error("expired");
        error.retryable = true;
        throw error;
      }
      return { status: "success" };
    },
  });

  await scheduler.start();
  assert.equal(calls, 2);
  assert.equal(job.tasks[0].status, "success");
});

test("a skipped worker result completes once and an exhausted calibration passes", async () => {
  const job = makeJob(1);
  let calls = 0;
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    sleep: async () => {},
    runLesson: async () => {
      calls += 1;
      return { status: "skipped" };
    },
  });

  const result = await scheduler.start();

  assert.equal(calls, 1);
  assert.equal(job.tasks[0].status, "skipped");
  assert.equal(result.calibration.passed, true);
  assert.equal(result.calibration.failedLessonId, null);
});

test("accepts a worker that already advanced through downloading and committing", async () => {
  const job = makeJob(1);
  let calls = 0;
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    runLesson: async (task, attemptToken) => {
      calls += 1;
      transitionTask(job, task.lessonId, "downloading", { attemptToken });
      transitionTask(job, task.lessonId, "committing", { attemptToken });
      return { status: "success" };
    },
  });

  const result = await scheduler.start();

  assert.equal(calls, 1);
  assert.equal(job.tasks[0].status, "success");
  assert.equal(result.calibration.passed, true);
});

test("dynamic skips do not count as successful calibration samples", async () => {
  const job = makeJob(7);
  const started = [];
  const activeDuringStart = [];
  const releases = new Map();
  let active = 0;
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    runLesson: async (task) => {
      started.push(task.lessonId);
      active += 1;
      activeDuringStart.push(active);
      if (!["lesson-1", "lesson-2"].includes(task.lessonId)) {
        await new Promise((resolve) => releases.set(task.lessonId, resolve));
      }
      active -= 1;
      return { status: ["lesson-1", "lesson-2"].includes(task.lessonId) ? "skipped" : "success" };
    },
  });

  const running = scheduler.start();
  for (let turn = 0; turn < 20 && !releases.has("lesson-3"); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(started, ["lesson-1", "lesson-2", "lesson-3"]);
  releases.get("lesson-3")();
  for (let turn = 0; turn < 20 && !releases.has("lesson-4"); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(started, ["lesson-1", "lesson-2", "lesson-3", "lesson-4"]);
  releases.get("lesson-4")();
  for (let turn = 0; turn < 20 && !releases.has("lesson-5"); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(started, ["lesson-1", "lesson-2", "lesson-3", "lesson-4", "lesson-5"]);
  releases.get("lesson-5")();
  for (let turn = 0; turn < 20 && !releases.has("lesson-7"); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(activeDuringStart.slice(0, 5), [1, 1, 1, 1, 1]);
  assert.equal(releases.has("lesson-6"), true);
  assert.equal(releases.has("lesson-7"), true);
  assert.equal(Math.max(...activeDuringStart), 2);
  releases.get("lesson-6")();
  releases.get("lesson-7")();
  const result = await running;
  assert.equal(result.calibration.successfulSamples, 3);
  assert.equal(result.calibration.passed, true);
});

test("calibration passes when the queue is exhausted before three real successes", async () => {
  const job = makeJob(3);
  const scheduler = createBatchScheduler({
    job,
    persist: async () => {},
    runLesson: async (task) => ({
      status: task.lessonId === "lesson-3" ? "success" : "skipped",
    }),
  });

  const result = await scheduler.start();

  assert.equal(result.calibration.successfulSamples, 1);
  assert.equal(result.calibration.passed, true);
  assert.deepEqual(job.tasks.map((task) => task.status), ["skipped", "skipped", "success"]);
});
