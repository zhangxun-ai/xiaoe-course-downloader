const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MANIFEST_FILENAME,
  buildBatchFilename,
  commitLessonFile,
  overwriteConflict,
  prepareLessonFile,
  readManifest,
  reconcileLessonFile,
  recoverCommittingLesson,
} = require("../shared/batch-files.js");
const { createDirectoryStore } = require("../shared/directory-store.js");
const { writeDirectMedia } = require("../shared/download-core.js");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeFileHandle {
  constructor(name, directory, options = {}) {
    this.kind = "file";
    this.name = name;
    this.directory = directory;
    this.closeDelay = options.closeDelay || null;
  }

  async getFile() {
    const bytes = this.directory.files.get(this.name) || new Uint8Array();
    return {
      size: bytes.byteLength,
      async text() { return decoder.decode(bytes); },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      slice(start = 0, end = bytes.byteLength) {
        const part = bytes.slice(start, end);
        return {
          async arrayBuffer() {
            return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
          },
        };
      },
    };
  }

  async createWritable(options) {
    assert.deepEqual(options, { keepExistingData: false });
    const handle = this;
    let staged = new Uint8Array();
    let closed = false;
    return {
      async write(value) {
        if (closed) throw new Error("writable closed");
        if (handle.directory.failWrites.has(handle.name)) throw new Error("simulated write failure");
        const source = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
        staged = source.slice();
      },
      async close() {
        if (closed) throw new Error("already closed");
        if (handle.closeDelay) await handle.closeDelay();
        if (handle.directory.failCloses.has(handle.name)) throw new Error("simulated close failure");
        closed = true;
        handle.directory.files.set(handle.name, staged);
        handle.directory.events.push(`closed:${handle.name}`);
      },
      async abort() {
        closed = true;
        handle.directory.events.push(`aborted:${handle.name}`);
      },
    };
  }
}

class FakeDirectoryHandle {
  constructor() {
    this.kind = "directory";
    this.files = new Map();
    this.events = [];
    this.failWrites = new Set();
    this.failCloses = new Set();
    this.closeDelays = new Map();
  }

  put(name, value) {
    this.files.set(name, typeof value === "string" ? encoder.encode(value) : new Uint8Array(value));
  }

  text(name) {
    return decoder.decode(this.files.get(name));
  }

  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name) && !create) throw notFound();
    if (!this.files.has(name)) this.files.set(name, new Uint8Array());
    return new FakeFileHandle(name, this, { closeDelay: this.closeDelays.get(name) });
  }

  async removeEntry(name) {
    if (!this.files.has(name)) throw notFound();
    this.files.delete(name);
    this.events.push(`removed:${name}`);
  }

  async *entries() {
    for (const name of this.files.keys()) {
      yield [name, await this.getFileHandle(name)];
    }
  }
}

function notFound() {
  return Object.assign(new Error("not found"), { name: "NotFoundError" });
}

function lesson(overrides = {}) {
  return {
    lessonId: "lesson-65",
    title: "65. 体制内的思考",
    ordinal: 65,
    extension: "mp3",
    ...overrides,
  };
}

function manifest(courseId = "course-1", lessons = []) {
  return JSON.stringify({ version: 1, courseId, lessons });
}

function context(directory, overrides = {}) {
  return {
    directory,
    jobId: "job-1",
    courseId: "course-1",
    lesson: lesson(),
    mediaType: "audio/mpeg",
    verified: true,
    ...overrides,
  };
}

function mp3Bytes() {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
}

test("reconciliation adopts a valid hyphenated legacy MP3 without downloading it again", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("87-迷茫期如何调整自己.mp3", mp3Bytes());
  const result = await reconcileLessonFile(context(directory, {
    lesson: lesson({
      lessonId: "lesson-87",
      ordinal: 87,
      title: "87. 迷茫期如何调整自己",
    }),
  }));

  assert.deepEqual(result, {
    status: "skipped",
    filename: "87-迷茫期如何调整自己.mp3",
    bytes: 8,
  });
  assert.equal((await readManifest(directory, "course-1")).lessons[0].lessonId, "lesson-87");
});

test("reconciliation does not mistake lesson 87 for lesson 8", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("87. 迷茫期如何调整自己.mp3", mp3Bytes());
  const result = await reconcileLessonFile(context(directory, {
    lesson: lesson({
      lessonId: "lesson-8",
      ordinal: 8,
      title: "8. 迷茫期如何调整自己",
    }),
  }));

  assert.deepEqual(result, { status: "writable" });
});

test("reconciliation removes a stale missing manifest record before redownloading", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put(MANIFEST_FILENAME, manifest("course-1", [{
    lessonId: "lesson-65",
    filename: "65. 体制内的思考.bin",
    bytes: 36_244,
    mediaType: "application/octet-stream",
    verified: true,
    completedAt: "2026-08-02T00:00:00.000Z",
  }]));

  const result = await reconcileLessonFile(context(directory));

  assert.deepEqual(result, { status: "writable" });
  assert.deepEqual((await readManifest(directory, "course-1")).lessons, []);
});

test("reconciliation keeps an invalid completed file as a conflict", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("65. 体制内的思考.mp3", encoder.encode("<!DOCTYPE html>"));
  directory.put(MANIFEST_FILENAME, manifest("course-1", [{
    lessonId: "lesson-65",
    filename: "65. 体制内的思考.mp3",
    bytes: 15,
    mediaType: "audio/mpeg",
    verified: true,
    completedAt: "2026-08-02T00:00:00.000Z",
  }]));

  const result = await reconcileLessonFile(context(directory));

  assert.deepEqual(result, {
    status: "conflict",
    filename: "65. 体制内的思考.mp3",
    bytes: 15,
  });
  assert.deepEqual((await readManifest(directory, "course-1")).lessons, []);
});

test("does not record an HTML payload as a completed MP3", async () => {
  const directory = new FakeDirectoryHandle();

  await assert.rejects(
    () => commitLessonFile(context(directory, {
      data: encoder.encode("<!DOCTYPE html>"),
      expectedBytes: 15,
      expectedMediaExtension: "mp3",
    })),
    /valid media|invalid media/i,
  );

  assert.equal(directory.files.has("65. 体制内的思考.mp3"), false);
  assert.deepEqual((await readManifest(directory, "course-1")).lessons, []);
});

test("manifest match with matching file size is skipped", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("65. 体制内的思考.mp3", new Uint8Array([1, 2, 3]));
  directory.put(MANIFEST_FILENAME, manifest("course-1", [
    {
      lessonId: "lesson-65",
      filename: "65. 体制内的思考.mp3",
      bytes: 3,
      mediaType: "audio/mpeg",
      verified: true,
      completedAt: "2026-08-02T00:00:00.000Z",
    },
  ]));

  const result = await prepareLessonFile(context(directory));

  assert.deepEqual(result, { status: "skipped", filename: "65. 体制内的思考.mp3", bytes: 3 });
});

test("missing media file returns a writable target even when a stale manifest record exists", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put(MANIFEST_FILENAME, manifest("course-1", [
    { lessonId: "lesson-65", filename: "65. 体制内的思考.mp3", bytes: 3 },
  ]));

  const result = await prepareLessonFile(context(directory));

  assert.equal(result.status, "writable");
  assert.equal(result.filename, "65. 体制内的思考.mp3");
});

test("an untracked zero-byte file is removed and offered for redownload", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("65. 体制内的思考.mp3", new Uint8Array());

  const result = await prepareLessonFile(context(directory));

  assert.equal(result.status, "writable");
  assert.equal(directory.files.has(result.filename), false);
  assert.ok(directory.events.includes(`removed:${result.filename}`));
});

test("an untracked nonzero file is a conflict", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("65. 体制内的思考.mp3", new Uint8Array([9]));

  const result = await prepareLessonFile(context(directory));

  assert.deepEqual(result, { status: "conflict", filename: "65. 体制内的思考.mp3", bytes: 1 });
});

test("failed media writes are aborted and the partial target is removed", async () => {
  const directory = new FakeDirectoryHandle();
  directory.failWrites.add("65. 体制内的思考.mp3");

  await assert.rejects(
    () => commitLessonFile(context(directory, { data: new Uint8Array([1, 2, 3]), expectedBytes: 3 })),
    /simulated write failure/,
  );

  assert.equal(directory.files.has("65. 体制内的思考.mp3"), false);
  assert.ok(directory.events.includes("aborted:65. 体制内的思考.mp3"));
});

test("a failed explicit overwrite never removes the pre-existing nonzero file", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("65. 体制内的思考.mp3", new Uint8Array([8, 8, 8]));
  directory.failWrites.add("65. 体制内的思考.mp3");

  await assert.rejects(
    () => commitLessonFile(context(directory, {
      data: new Uint8Array([1, 2, 3]),
      expectedBytes: 3,
      overwrite: true,
    })),
    /simulated write failure/,
  );

  assert.equal(directory.files.has("65. 体制内的思考.mp3"), true);
  if (directory.files.has("65. 体制内的思考.mp3")) {
    assert.deepEqual([...directory.files.get("65. 体制内的思考.mp3")], [8, 8, 8]);
  }
  assert.equal(directory.events.includes("removed:65. 体制内的思考.mp3"), false);
});

test("committing recovery records a file only when it has the expected byte size", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("65. 体制内的思考.mp3", new Uint8Array([1, 2, 3]));

  const recovered = await recoverCommittingLesson(context(directory, { expectedBytes: 3 }));
  assert.equal(recovered.status, "success");
  assert.equal(recovered.recovered, true);
  const recoveredRecord = (await readManifest(directory, "course-1")).lessons[0];
  assert.deepEqual(
    { ...recoveredRecord, completedAt: undefined },
    {
      lessonId: "lesson-65",
      filename: "65. 体制内的思考.mp3",
      bytes: 3,
      mediaType: "audio/mpeg",
      verified: true,
      completedAt: undefined,
    },
  );
  assert.match(recoveredRecord.completedAt, /^\d{4}-\d{2}-\d{2}T/);

  directory.put("another.mp3", new Uint8Array([1, 2]));
  const mismatched = await recoverCommittingLesson(context(directory, {
    lesson: lesson({ lessonId: "another", title: "another", ordinal: 66 }),
    filename: "another.mp3",
    expectedBytes: 3,
  }));
  assert.deepEqual(mismatched, { status: "conflict", filename: "another.mp3", bytes: 2 });
});

test("explicit overwrite removes an untracked conflict and returns a writable target", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("65. 体制内的思考.mp3", new Uint8Array([9]));

  const result = await overwriteConflict(context(directory));

  assert.equal(result.status, "writable");
  assert.equal(directory.files.has(result.filename), false);
});

test("two concurrent commits re-read under the job lock and retain both manifest records", async () => {
  const directory = new FakeDirectoryHandle();
  let releaseFirstClose;
  directory.closeDelays.set(MANIFEST_FILENAME, () => new Promise((resolve) => { releaseFirstClose = resolve; }));
  const first = commitLessonFile(context(directory, {
    lesson: lesson({ lessonId: "lesson-1", title: "First", ordinal: 1 }),
    data: new Uint8Array([1]),
    expectedBytes: 1,
  }));

  while (!releaseFirstClose) await new Promise((resolve) => setImmediate(resolve));
  directory.closeDelays.delete(MANIFEST_FILENAME);
  const second = commitLessonFile(context(directory, {
    lesson: lesson({ lessonId: "lesson-2", title: "Second", ordinal: 2 }),
    data: new Uint8Array([2, 2]),
    expectedBytes: 2,
  }));
  releaseFirstClose();
  await Promise.all([first, second]);

  const finalManifest = await readManifest(directory, "course-1");
  assert.deepEqual(finalManifest.lessons.map((entry) => entry.lessonId).sort(), ["lesson-1", "lesson-2"]);
});

test("different jobs for one course share the manifest lock and retain both records", async () => {
  const directory = new FakeDirectoryHandle();
  await Promise.all([
    commitLessonFile(context(directory, {
      jobId: "full-job",
      lesson: lesson({ lessonId: "lesson-1", title: "First", ordinal: 1 }),
      data: new Uint8Array([1]),
      expectedBytes: 1,
    })),
    commitLessonFile(context(directory, {
      jobId: "checkpoint-job",
      lesson: lesson({ lessonId: "lesson-2", title: "Second", ordinal: 2 }),
      data: new Uint8Array([2]),
      expectedBytes: 1,
    })),
  ]);

  assert.deepEqual(
    (await readManifest(directory, "course-1")).lessons.map((entry) => entry.lessonId).sort(),
    ["lesson-1", "lesson-2"],
  );
});

test("two lessons concurrently committing the same filename cannot both succeed", async () => {
  const directory = new FakeDirectoryHandle();
  const filename = "shared.mp3";
  const results = await Promise.allSettled([
    commitLessonFile(context(directory, {
      filename,
      lesson: lesson({ lessonId: "lesson-1", title: "First", ordinal: 1 }),
      data: new Uint8Array([1]),
      expectedBytes: 1,
    })),
    commitLessonFile(context(directory, {
      filename,
      lesson: lesson({ lessonId: "lesson-2", title: "Second", ordinal: 2 }),
      data: new Uint8Array([2]),
      expectedBytes: 1,
    })),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const finalManifest = await readManifest(directory, "course-1");
  assert.equal(finalManifest.lessons.length, 1);
  assert.equal(finalManifest.lessons[0].filename, filename);
});

test("prepare cannot remove a zero-byte target while its commit owns the filename lock", async () => {
  const directory = new FakeDirectoryHandle();
  let writerStarted;
  let releaseWriter;
  const started = new Promise((resolve) => { writerStarted = resolve; });
  const release = new Promise((resolve) => { releaseWriter = resolve; });
  const committing = commitLessonFile(context(directory, {
    expectedBytes: 1,
    async write(writable) {
      await writable.write(new Uint8Array([1]));
      writerStarted();
      await release;
      return { bytesWritten: 1 };
    },
  }));
  await started;

  let prepareSettled = false;
  const preparing = prepareLessonFile(context(directory)).then((result) => {
    prepareSettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepareSettled, false);

  releaseWriter();
  await committing;
  assert.equal((await preparing).status, "skipped");
});

test("runner-style direct download leaves close ownership to commit and supplies byte count", async () => {
  const directory = new FakeDirectoryHandle();
  await commitLessonFile(context(directory, {
    write: (writable) => writeDirectMedia(
      "https://cdn.example.com/media.mp3",
      async () => new Response(new Uint8Array([1, 2, 3, 4])),
      writable,
      undefined,
      { close: false },
    ),
  }));

  assert.equal(directory.events.filter((event) => event === "closed:65. 体制内的思考.mp3").length, 1);
  assert.equal((await readManifest(directory, "course-1")).lessons[0].bytes, 4);
});

test("beforeClose is awaited after media bytes are written and before the media writable closes", async () => {
  const directory = new FakeDirectoryHandle();
  let releaseHook;
  const hookGate = new Promise((resolve) => { releaseHook = resolve; });
  const committing = commitLessonFile(context(directory, {
    expectedBytes: 3,
    async write(writable) {
      await writable.write(new Uint8Array([1, 2, 3]));
      directory.events.push("media-written");
      return { bytesWritten: 3 };
    },
    async beforeClose(details) {
      directory.events.push(`before-close:${details.filename}:${details.bytesWritten}`);
      await hookGate;
      directory.events.push("before-close-finished");
    },
  }));

  while (!directory.events.some((event) => event.startsWith("before-close:"))) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(directory.events, [
    "media-written",
    "before-close:65. 体制内的思考.mp3:3",
  ]);

  releaseHook();
  await committing;
  assert.deepEqual(directory.events.slice(0, 4), [
    "media-written",
    "before-close:65. 体制内的思考.mp3:3",
    "before-close-finished",
    "closed:65. 体制内的思考.mp3",
  ]);
});

test("commit rejects callbacks that try to close its writable", async () => {
  const directory = new FakeDirectoryHandle();
  await assert.rejects(
    () => commitLessonFile(context(directory, {
      expectedBytes: 1,
      async write(writable) {
        await writable.write(new Uint8Array([1]));
        await writable.close();
        return { bytesWritten: 1 };
      },
    })),
    /must not close|already closed/i,
  );
  assert.equal(directory.files.has("65. 体制内的思考.mp3"), false);
});

test("media close happens before manifest close and manifest close is required for success", async () => {
  const directory = new FakeDirectoryHandle();
  await commitLessonFile(context(directory, { data: new Uint8Array([1]), expectedBytes: 1 }));
  assert.deepEqual(directory.events.filter((event) => event.startsWith("closed:")), [
    "closed:65. 体制内的思考.mp3",
    `closed:${MANIFEST_FILENAME}`,
  ]);

  const failing = new FakeDirectoryHandle();
  failing.failCloses.add(MANIFEST_FILENAME);
  await assert.rejects(
    () => commitLessonFile(context(failing, { data: new Uint8Array([1]), expectedBytes: 1 })),
    /simulated close failure/,
  );
});

test("numbered lesson titles are not prefixed twice and illegal characters are sanitized", () => {
  assert.equal(buildBatchFilename(lesson()), "65. 体制内的思考.mp3");
  assert.equal(
    buildBatchFilename(lesson({ title: "坏<标>题:/\\|?*：\u0001", ordinal: 7 })),
    "007-坏 标 题.mp3",
  );
});

for (const [name, manifestText] of [
  ["malformed JSON", "{"],
  ["wrong courseId", manifest("other-course", [])],
  ["duplicate lessonId", manifest("course-1", [
    { lessonId: "lesson-65", filename: "65. 体制内的思考.mp3", bytes: 3 },
    { lessonId: "lesson-65", filename: "copy.mp3", bytes: 3 },
  ])],
  ["duplicate filename owner", manifest("course-1", [
    { lessonId: "lesson-1", filename: "same.mp3", bytes: 1 },
    { lessonId: "lesson-2", filename: "same.mp3", bytes: 1 },
  ])],
]) {
  test(`${name} manifest fails safely and never skips an existing media file`, async () => {
    const directory = new FakeDirectoryHandle();
    directory.put("65. 体制内的思考.mp3", new Uint8Array([1, 2, 3]));
    directory.put(MANIFEST_FILENAME, manifestText);

    await assert.rejects(() => prepareLessonFile(context(directory)), /manifest/i);
    assert.equal(directory.files.has("65. 体制内的思考.mp3"), true);
  });
}

test("legacy manifest entries without verification evidence never skip", async () => {
  const directory = new FakeDirectoryHandle();
  directory.put("65. 体制内的思考.mp3", new Uint8Array([1, 2, 3]));
  directory.put(MANIFEST_FILENAME, manifest("course-1", [
    { lessonId: "lesson-65", filename: "65. 体制内的思考.mp3", bytes: 3 },
  ]));

  assert.deepEqual(await prepareLessonFile(context(directory)), {
    status: "conflict",
    filename: "65. 体制内的思考.mp3",
    bytes: 3,
  });
});

test("commit requires verification evidence and manifest preserves completion evidence", async () => {
  const directory = new FakeDirectoryHandle();
  await assert.rejects(
    () => commitLessonFile(context(directory, {
      verified: false,
      data: new Uint8Array([1]),
      expectedBytes: 1,
    })),
    /verified|verification/i,
  );
  assert.equal(directory.files.has("65. 体制内的思考.mp3"), false);

  await commitLessonFile(context(directory, {
    data: new Uint8Array([1]),
    expectedBytes: 1,
    duration: 42.5,
    completedAt: "2026-08-02T01:02:03.000Z",
  }));
  assert.deepEqual((await readManifest(directory, "course-1")).lessons[0], {
    lessonId: "lesson-65",
    filename: "65. 体制内的思考.mp3",
    bytes: 1,
    mediaType: "audio/mpeg",
    verified: true,
    completedAt: "2026-08-02T01:02:03.000Z",
    duration: 42.5,
  });
});

function fakeIndexedDb() {
  const records = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {
        error: null,
        objectStore() {
          return {
            put(value, key) { return request(() => records.set(key, value)); },
            get(key) { return request(() => records.get(key)); },
            delete(key) { return request(() => records.delete(key)); },
          };
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  return {
    records,
    open() { return request(() => db); },
  };
}

function request(operation) {
  const result = {};
  queueMicrotask(() => {
    try {
      result.result = operation();
      result.onsuccess?.();
    } catch (error) {
      result.error = error;
      result.onerror?.();
    }
  });
  return result;
}

test("directory store saves by jobId and checks/request readwrite permission when loading", async () => {
  const indexedDB = fakeIndexedDb();
  const permissionCalls = [];
  const handle = {
    kind: "directory",
    async queryPermission(options) { permissionCalls.push(["query", options]); return "prompt"; },
    async requestPermission(options) { permissionCalls.push(["request", options]); return "granted"; },
  };
  const store = createDirectoryStore({ indexedDB });

  await store.save("job-1", handle);
  assert.equal(await store.load("job-1"), handle);
  assert.deepEqual(permissionCalls, [
    ["query", { mode: "readwrite" }],
    ["request", { mode: "readwrite" }],
  ]);
  await store.delete("job-1");
  assert.equal(await store.load("job-1"), null);
});

test("directory store rejects denied permission and invalid handles", async () => {
  const indexedDB = fakeIndexedDb();
  const store = createDirectoryStore({ indexedDB });
  await assert.rejects(() => store.save("job-1", { kind: "file" }), /directory handle/i);
  await store.save("job-2", {
    kind: "directory",
    async queryPermission() { return "denied"; },
    async requestPermission() { return "denied"; },
  });
  await assert.rejects(() => store.load("job-2"), /permission/i);
});
