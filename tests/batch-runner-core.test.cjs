const test = require("node:test");
const assert = require("node:assert/strict");

const { createBatchJob } = require("../shared/batch-state.js");
const { createBatchRunnerCore } = require("../shared/batch-runner-core.js");

function makeJob(count = 6) {
  return createBatchJob({
    jobId: "job-1",
    courseId: "course-1",
    fingerprint: "fp-1",
    lessons: Array.from({ length: count }, (_, offset) => ({
      lessonId: `lesson-${offset + 1}`,
      index: offset + 1,
      title: `${offset + 1}. Lesson`,
      pageUrl: `https://school.test/${offset + 1}`,
    })),
  });
}

function harness(overrides = {}) {
  const job = overrides.job || makeJob();
  const events = [];
  const persisted = [];
  const directory = { kind: "directory" };
  let active = 0;
  let peak = 0;
  const core = createBatchRunnerCore({
    job,
    persist: async (snapshot) => {
      persisted.push(structuredClone(snapshot));
      events.push(`persist:${snapshot.tasks.map((task) => task.status).join(",")}`);
    },
    saveDirectory: async (jobId, value) => {
      assert.equal(jobId, job.jobId);
      assert.equal(value, directory);
      events.push("save-directory");
    },
    resolver: {
      async resolve(pageUrl) {
        if (overrides.resolve) return overrides.resolve(pageUrl);
        events.push(`resolve:${pageUrl}`);
        return { url: `${pageUrl}.mp3?token=fresh`, kind: "direct", extension: "mp3", mime: "audio/mpeg" };
      },
    },
    files: {
      async reconcileLessonFile(options) {
        return overrides.reconcileResult?.(options) || { status: "writable" };
      },
      async prepareLessonFile(options) {
        events.push(`prepare:${options.lesson.lessonId}`);
        return { status: "writable", filename: `${options.lesson.title}.mp3` };
      },
      async commitLessonFile(options) {
        events.push(`commit:${options.lesson.lessonId}`);
        const writable = { async write() {}, async abort() {} };
        const result = await options.write(writable);
        await options.beforeClose({
          filename: options.filename,
          bytesWritten: result.bytesWritten,
          mediaType: options.mediaType,
        });
        events.push(`close:${options.lesson.lessonId}`);
        return {
          status: "success",
          filename: options.filename,
          bytes: result.bytesWritten,
          verified: true,
          mediaType: options.mediaType,
        };
      },
      async overwriteConflict() { return { status: "writable" }; },
    },
    downloader: {
      async loadHlsPlan() { throw new Error("not HLS"); },
      async writeDirectMedia(_url, _fetch, _writable, onProgress, options) {
        assert.deepEqual(options, { close: false });
        active += 1;
        peak = Math.max(peak, active);
        events.push("write");
        onProgress?.({ bytesWritten: 4, contentLength: 4 });
        await overrides.downloadGate?.();
        active -= 1;
        return { bytesWritten: 4 };
      },
      async writeHlsResources() { throw new Error("not HLS"); },
    },
    fetchImpl: async () => { throw new Error("unused"); },
    lockManager: overrides.lockManager,
    ...overrides.dependencies,
  });
  return { core, directory, events, job, peak: () => peak, persisted };
}

test("skips a reconciled legacy file without resolving its media again", async () => {
  const h = harness({
    job: makeJob(1),
    reconcileResult: () => ({ status: "skipped", filename: "1. Lesson.mp3", bytes: 8 }),
    resolve: () => { throw new Error("resolver must not run for an adopted file"); },
  });

  await h.core.start(h.directory);

  assert.equal(h.job.tasks[0].status, "skipped");
  assert.equal(h.events.some((event) => event.startsWith("resolve:")), false);
  assert.equal(h.events.includes("write"), false);
});

test("selects and saves one directory once, then runs three real successes serially before concurrency two", async () => {
  let pickerCalls = 0;
  let releaseParallel;
  const parallelGate = new Promise((resolve) => { releaseParallel = resolve; });
  let writes = 0;
  const h = harness({
    async downloadGate() {
      writes += 1;
      if (writes > 3) await parallelGate;
    },
  });

  const running = h.core.startWithDirectoryPicker(() => {
    pickerCalls += 1;
    return Promise.resolve(h.directory);
  });
  while (h.events.filter((event) => event === "write").length < 5) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(pickerCalls, 1);
  assert.deepEqual(h.events.filter((event) => event.startsWith("resolve:")).slice(0, 3), [
    "resolve:https://school.test/1",
    "resolve:https://school.test/2",
    "resolve:https://school.test/3",
  ]);
  assert.equal(h.peak(), 2);
  releaseParallel();
  const result = await running;
  assert.equal(result.readOnly, false);
  assert.equal(h.job.tasks.every((task) => task.status === "success"), true);
});

test("persists resolving before resolve, downloading before write, and committing before close", async () => {
  const h = harness({ job: makeJob(1) });
  await h.core.start(h.directory);

  const resolveIndex = h.events.findIndex((event) => event.startsWith("resolve:"));
  const commitIndex = h.events.findIndex((event) => event.startsWith("commit:"));
  const closeIndex = h.events.findIndex((event) => event.startsWith("close:"));
  assert.match(h.events[resolveIndex - 1], /^persist:resolving$/);
  assert.match(h.events[commitIndex - 1], /^persist:downloading$/);
  assert.match(h.events[closeIndex - 1], /^persist:committing$/);
});

test("stop prevents dispatching a new lesson while the current write finishes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ job: makeJob(4), downloadGate: () => gate });
  const running = h.core.start(h.directory);
  while (!h.events.includes("write")) await new Promise((resolve) => setImmediate(resolve));
  await h.core.stop();
  release();
  const result = await running;

  assert.equal(result.stopped, true);
  assert.equal(h.events.filter((event) => event.startsWith("resolve:")).length, 1);
  assert.equal(h.job.tasks[1].status, "pending");
});

test("a stale attempt-token progress callback is ignored", async () => {
  const job = makeJob(1);
  const h = harness({
    job,
    dependencies: {
      downloader: {
        async loadHlsPlan() { throw new Error("unused"); },
        async writeDirectMedia(_url, _fetch, _writable, onProgress) {
          job.tasks[0].attemptToken = "newer-attempt";
          onProgress({ bytesWritten: 99, contentLength: 100 });
          return { bytesWritten: 4 };
        },
        async writeHlsResources() { throw new Error("unused"); },
      },
    },
  });
  await h.core.start(h.directory);
  assert.equal(job.tasks[0].bytesWritten, 0);
});

test("a duplicate runner lock returns read-only without touching the job", async () => {
  const h = harness({
    job: makeJob(1),
    lockManager: {
      async request(name, options, callback) {
        assert.equal(name, "xiaoe-batch-job:job-1");
        assert.deepEqual(options, { ifAvailable: true });
        return callback(null);
      },
    },
  });
  const result = await h.core.start(h.directory);
  assert.deepEqual(result, { readOnly: true, job: h.job });
  assert.equal(h.events.length, 0);
  assert.equal(h.job.tasks[0].status, "pending");
});

test("a cancelled directory picker can be used again on the same preview", async () => {
  const h = harness({ job: makeJob(1) });
  const cancelled = Object.assign(new Error("cancelled"), { name: "AbortError" });
  await assert.rejects(
    () => h.core.startWithDirectoryPicker(() => Promise.reject(cancelled)),
    { name: "AbortError" },
  );

  const result = await h.core.startWithDirectoryPicker(() => Promise.resolve(h.directory));
  assert.equal(result.readOnly, false);
  assert.equal(h.job.tasks[0].status, "success");
});

test("resetFailed restores a fresh attempt budget and clears stale attempt state", async () => {
  const job = makeJob(1);
  Object.assign(job.tasks[0], {
    status: "failed",
    attempts: 3,
    attemptToken: null,
    error: "old failure",
    bytesWritten: 123,
    contentLength: 456,
  });
  const h = harness({ job });

  await h.core.resetFailed();

  assert.deepEqual(
    {
      status: job.tasks[0].status,
      attempts: job.tasks[0].attempts,
      attemptToken: job.tasks[0].attemptToken,
      error: job.tasks[0].error,
      bytesWritten: job.tasks[0].bytesWritten,
      contentLength: job.tasks[0].contentLength,
    },
    {
      status: "pending",
      attempts: 0,
      attemptToken: null,
      error: null,
      bytesWritten: 0,
      contentLength: 0,
    },
  );
});
