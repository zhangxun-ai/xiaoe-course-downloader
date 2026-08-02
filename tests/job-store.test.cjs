const test = require("node:test");
const assert = require("node:assert/strict");

const { createJobStore } = require("../shared/job-store.js");

function memoryArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => data.has(key)).map((key) => [key, data.get(key)]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
  };
}

function makeStore(options = {}) {
  const session = memoryArea();
  const local = memoryArea();
  const handles = new Map();
  let handleDeletes = 0;
  let remainingHandleDeleteFailures = options.handleDeleteFailures || 0;
  const store = createJobStore({
    session,
    local,
    handleStore: {
      async delete(id) {
        handleDeletes += 1;
        if (remainingHandleDeleteFailures > 0) {
          remainingHandleDeleteFailures -= 1;
          throw new Error("handle delete failed");
        }
        handles.delete(id);
      },
    },
  });
  return { store, session, local, handles, getHandleDeletes: () => handleDeletes };
}

test("creates an ephemeral draft in session storage only", async () => {
  const { store, session, local } = makeStore();
  const draft = { draftId: "draft-1", courseId: "course-1", fingerprint: "fp-1", lessons: [] };

  await store.createDraft(draft);

  assert.deepEqual(session.data.get("batchDraft:draft-1"), draft);
  assert.equal(local.data.size, 0);
});

test("persists a full job and matching course index", async () => {
  const { store, local } = makeStore();
  const job = { jobId: "job-1", courseId: "course-1", fingerprint: "fp-1", directoryHandleId: "handle-1", tasks: [] };

  await store.saveFullJob(job);

  assert.deepEqual(local.data.get("batchJob:job-1"), job);
  assert.deepEqual(local.data.get("batchJobIndex:course-1"), { jobId: "job-1", fingerprint: "fp-1" });
});

test("persists a checkpoint job without creating a course index", async () => {
  const { store, local } = makeStore();
  const checkpoint = { jobId: "checkpoint-1", courseId: "course-1", fingerprint: "fp-1", checkpoint: true, tasks: [] };

  await store.saveCheckpoint(checkpoint);

  assert.deepEqual(local.data.get("batchJob:checkpoint-1"), checkpoint);
  assert.equal(local.data.has("batchJobIndex:course-1"), false);
});

test("storage boundaries strip signed media URLs from full and checkpoint jobs", async () => {
  const { store, local } = makeStore();
  const fullJob = {
    jobId: "job-1",
    courseId: "course-1",
    fingerprint: "fp-1",
    tasks: [{ lessonId: "lesson-1", mediaUrl: "https://signed.test/full.mp3", nested: { mediaUrl: "https://signed.test/nested.mp3" } }],
  };
  const checkpoint = {
    jobId: "checkpoint-1",
    courseId: "course-1",
    fingerprint: "fp-1",
    tasks: [{ lessonId: "lesson-2", mediaUrl: "https://signed.test/checkpoint.mp3" }],
  };

  await store.saveFullJob(fullJob);
  await store.saveCheckpoint(checkpoint);

  assert.equal(JSON.stringify(local.data.get("batchJob:job-1")).includes("signed.test"), false);
  assert.equal(JSON.stringify(local.data.get("batchJob:checkpoint-1")).includes("signed.test"), false);
  assert.equal(fullJob.tasks[0].mediaUrl.includes("signed.test"), true);
});

test("resumes only when courseId and fingerprint match the indexed job", async () => {
  const { store } = makeStore();
  const job = { jobId: "job-1", courseId: "course-1", fingerprint: "fp-1", tasks: [{ status: "pending" }] };
  await store.saveFullJob(job);

  assert.deepEqual(await store.findResumeJob("course-1", "fp-1"), job);
  assert.equal(await store.findResumeJob("course-1", "different"), null);
  assert.equal(await store.findResumeJob("course-2", "fp-1"), null);
});

test("does not resume a fully terminal successful or skipped job", async () => {
  const { store } = makeStore();
  const job = {
    jobId: "job-1",
    courseId: "course-1",
    fingerprint: "fp-1",
    tasks: [{ status: "success" }, { status: "skipped" }],
  };
  await store.saveFullJob(job);
  assert.equal(await store.findResumeJob("course-1", "fp-1"), null);
});

test("deletion is idempotent and removes job, only its matching index, and handle reference", async () => {
  const { store, local, handles, getHandleDeletes } = makeStore();
  const job = { jobId: "job-1", courseId: "course-1", fingerprint: "fp-1", directoryHandleId: "handle-1", tasks: [] };
  handles.set("handle-1", { opaque: true });
  await store.saveFullJob(job);

  await store.deleteJob("job-1");
  await store.deleteJob("job-1");

  assert.equal(local.data.has("batchJob:job-1"), false);
  assert.equal(local.data.has("batchJobIndex:course-1"), false);
  assert.equal(handles.has("handle-1"), false);
  assert.equal(getHandleDeletes(), 1);

  local.data.set("batchJob:job-2", { jobId: "job-2", courseId: "course-2", directoryHandleId: "handle-2", tasks: [] });
  local.data.set("batchJobIndex:course-2", { jobId: "newer-job", fingerprint: "newer" });
  await store.deleteJob("job-2");
  assert.deepEqual(local.data.get("batchJobIndex:course-2"), { jobId: "newer-job", fingerprint: "newer" });
});

test("a failed handle deletion preserves local state so cleanup can be retried", async () => {
  const { store, local, handles, getHandleDeletes } = makeStore({ handleDeleteFailures: 1 });
  const job = { jobId: "job-1", courseId: "course-1", fingerprint: "fp-1", directoryHandleId: "handle-1", tasks: [] };
  handles.set("handle-1", { opaque: true });
  await store.saveFullJob(job);

  await assert.rejects(() => store.deleteJob("job-1"), /handle delete failed/i);
  assert.deepEqual(local.data.get("batchJob:job-1"), job);
  assert.deepEqual(local.data.get("batchJobIndex:course-1"), { jobId: "job-1", fingerprint: "fp-1" });
  assert.equal(handles.has("handle-1"), true);

  assert.equal(await store.deleteJob("job-1"), true);
  assert.equal(local.data.has("batchJob:job-1"), false);
  assert.equal(local.data.has("batchJobIndex:course-1"), false);
  assert.equal(handles.has("handle-1"), false);
  assert.equal(getHandleDeletes(), 2);
});
