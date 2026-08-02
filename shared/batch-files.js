(function attachBatchFiles(root, factory) {
  const mediaUtils = typeof module === "object" && module.exports
    ? require("./media-utils.js")
    : root?.XiaoeMediaUtils;
  const api = factory(mediaUtils);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XiaoeBatchFiles = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBatchFilesModule(mediaUtils) {
  "use strict";

  const MANIFEST_FILENAME = ".xiaoe-batch-manifest.json";
  const MANIFEST_VERSION = 1;
  const localQueues = new Map();
  const MEDIA_EXTENSIONS = new Set(["aac", "flac", "m4a", "mov", "mp3", "mp4", "ogg", "ts", "wav", "webm"]);
  const MEDIA_TYPES = {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    ts: "video/mp2t",
    wav: "audio/wav",
    webm: "video/webm",
  };

  function isNotFound(error) {
    return error?.name === "NotFoundError";
  }

  function requireIdentity({ jobId, courseId, lesson }) {
    if (!String(jobId || "").trim()) throw new Error("Batch file operation requires jobId");
    if (!String(courseId || "").trim()) throw new Error("Batch file operation requires courseId");
    if (!String(lesson?.lessonId || "").trim()) throw new Error("Batch file operation requires lessonId");
  }

  function buildBatchFilename(lesson) {
    if (!mediaUtils?.buildFilename) throw new Error("XiaoeMediaUtils is unavailable");
    return mediaUtils.buildFilename(lesson?.title, lesson?.extension, lesson?.ordinal);
  }

  function resolveFilename(options, manifestEntry) {
    return String(options.filename || manifestEntry?.filename || buildBatchFilename(options.lesson));
  }

  function emptyManifest(courseId) {
    return { version: MANIFEST_VERSION, courseId, lessons: [] };
  }

  function validateManifest(value, courseId) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Manifest must be a JSON object");
    }
    if (value.version !== MANIFEST_VERSION) throw new Error("Manifest version is unsupported");
    if (value.courseId !== courseId) throw new Error("Manifest courseId does not match this course");
    if (!Array.isArray(value.lessons)) throw new Error("Manifest lessons must be an array");

    const seen = new Set();
    const seenFilenames = new Set();
    const lessons = value.lessons.map((entry) => {
      const lessonId = String(entry?.lessonId || "").trim();
      const filename = String(entry?.filename || "").trim();
      const bytes = entry?.bytes;
      if (!lessonId || !filename || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("Manifest contains an invalid lesson record");
      }
      if (seen.has(lessonId)) throw new Error(`Manifest contains duplicate lessonId: ${lessonId}`);
      if (seenFilenames.has(filename)) throw new Error(`Manifest contains duplicate filename owner: ${filename}`);
      seen.add(lessonId);
      seenFilenames.add(filename);
      const record = { lessonId, filename, bytes };
      if (Object.hasOwn(entry, "mediaType")) {
        if (!String(entry.mediaType || "").trim()) throw new Error("Manifest contains an invalid mediaType");
        record.mediaType = String(entry.mediaType).trim();
      }
      if (Object.hasOwn(entry, "verified")) {
        if (typeof entry.verified !== "boolean") throw new Error("Manifest contains an invalid verified flag");
        record.verified = entry.verified;
      }
      if (Object.hasOwn(entry, "completedAt")) {
        if (!String(entry.completedAt || "").trim()) throw new Error("Manifest contains an invalid completedAt");
        record.completedAt = String(entry.completedAt);
      }
      if (Object.hasOwn(entry, "duration")) {
        if (!Number.isFinite(entry.duration) || entry.duration < 0) throw new Error("Manifest contains an invalid duration");
        record.duration = entry.duration;
      }
      return record;
    });
    return { version: MANIFEST_VERSION, courseId, lessons };
  }

  async function readManifestUnlocked(directory, courseId) {
    let handle;
    try {
      handle = await directory.getFileHandle(MANIFEST_FILENAME);
    } catch (error) {
      if (isNotFound(error)) return emptyManifest(courseId);
      throw error;
    }

    try {
      const file = await handle.getFile();
      const parsed = JSON.parse(await file.text());
      return validateManifest(parsed, courseId);
    } catch (error) {
      if (/^Manifest\b/.test(error?.message || "")) throw error;
      throw new Error(`Manifest could not be read: ${error?.message || error}`);
    }
  }

  async function readManifest(directory, courseId) {
    return readManifestUnlocked(directory, courseId);
  }

  async function writeManifestUnlocked(directory, manifest) {
    const handle = await directory.getFileHandle(MANIFEST_FILENAME, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(JSON.stringify(manifest, null, 2));
      await writable.close();
    } catch (error) {
      try { await writable.abort?.(); } catch {}
      throw error;
    }
  }

  async function withLocalQueue(name, callback) {
    const previous = localQueues.get(name) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    localQueues.set(name, tail);
    await previous.catch(() => {});
    try {
      return await callback();
    } finally {
      release();
      if (localQueues.get(name) === tail) localQueues.delete(name);
    }
  }

  async function withNamedLock(options, name, callback) {
    const locks = options.lockManager || globalThis.navigator?.locks;
    if (locks?.request) return locks.request(name, callback);
    return withLocalQueue(name, callback);
  }

  function withManifestLock(options, callback) {
    return withNamedLock(options, `xiaoe-manifest:${options.courseId}`, callback);
  }

  function withFileLock(options, filename, callback) {
    return withNamedLock(options, `xiaoe-file:${options.courseId}:${filename}`, callback);
  }

  async function fileInfo(directory, filename) {
    try {
      const handle = await directory.getFileHandle(filename);
      const file = await handle.getFile();
      return { handle, size: file.size };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  function extensionFromFilename(filename) {
    const match = String(filename || "").match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase() : "";
  }

  function textAt(bytes, start, value) {
    return value.split("").every((character, offset) => (
      bytes[start + offset] === character.charCodeAt(0)
    ));
  }

  function hasSupportedMediaHeader(bytes, extension) {
    if (!bytes?.length) return false;
    if (extension === "mp3") {
      return textAt(bytes, 0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    }
    if (["m4a", "mp4", "mov"].includes(extension)) return textAt(bytes, 4, "ftyp");
    if (extension === "wav") return textAt(bytes, 0, "RIFF") && textAt(bytes, 8, "WAVE");
    if (extension === "flac") return textAt(bytes, 0, "fLaC");
    if (extension === "ogg") return textAt(bytes, 0, "OggS");
    if (extension === "aac") return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
    if (extension === "webm") return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    if (extension === "ts") return bytes[0] === 0x47;
    return false;
  }

  async function inspectMediaFile(directory, filename) {
    const info = await fileInfo(directory, filename);
    if (!info) return null;
    const extension = extensionFromFilename(filename);
    if (!MEDIA_EXTENSIONS.has(extension)) return { ...info, extension, valid: false };
    const file = await info.handle.getFile();
    const headerFile = typeof file.slice === "function" ? file.slice(0, 16) : file;
    const bytes = new Uint8Array(await headerFile.arrayBuffer());
    return {
      ...info,
      extension,
      valid: hasSupportedMediaHeader(bytes, extension),
    };
  }

  function normalizedTitle(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/^\s*\d+\s*[.\-_、]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function legacyFilenameMatchesLesson(filename, lesson) {
    const match = String(filename || "").match(/^(\d+)\s*[.\-_、]\s*(.+)\.([a-z0-9]{2,5})$/i);
    const ordinal = Number(lesson?.ordinal ?? lesson?.lessonNumber ?? lesson?.index ?? lesson?.order);
    if (!match || !Number.isSafeInteger(ordinal) || Number(match[1]) !== ordinal) return false;
    return MEDIA_EXTENSIONS.has(match[3].toLowerCase())
      && normalizedTitle(match[2]) === normalizedTitle(lesson?.title);
  }

  async function removeIfPresent(directory, filename) {
    try {
      await directory.removeEntry(filename);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  function findLesson(manifest, lessonId) {
    return manifest.lessons.find((entry) => entry.lessonId === lessonId);
  }

  function findFilenameOwner(manifest, filename) {
    return manifest.lessons.find((entry) => entry.filename === filename);
  }

  async function reconcileLessonFile(options) {
    requireIdentity(options);
    return withManifestLock(options, async () => {
      const manifest = await readManifestUnlocked(options.directory, options.courseId);
      const lessonId = options.lesson.lessonId;
      const record = findLesson(manifest, lessonId);
      if (record) {
        const inspected = await inspectMediaFile(options.directory, record.filename);
        if (!inspected) {
          await writeManifestUnlocked(options.directory, {
            ...manifest,
            lessons: manifest.lessons.filter((entry) => entry.lessonId !== lessonId),
          });
          return { status: "writable" };
        }
        if (!inspected.valid) {
          await writeManifestUnlocked(options.directory, {
            ...manifest,
            lessons: manifest.lessons.filter((entry) => entry.lessonId !== lessonId),
          });
          return { status: "conflict", filename: record.filename, bytes: inspected.size };
        }
        if (record.bytes === inspected.size && hasCompletionEvidence(record)) {
          return { status: "skipped", filename: record.filename, bytes: inspected.size };
        }
        const adopted = {
          lessonId,
          filename: record.filename,
          bytes: inspected.size,
          mediaType: MEDIA_TYPES[inspected.extension],
          verified: true,
          completedAt: new Date().toISOString(),
        };
        await writeManifestUnlocked(options.directory, upsertLesson(manifest, adopted));
        return { status: "skipped", filename: adopted.filename, bytes: adopted.bytes };
      }

      const matches = [];
      if (typeof options.directory.entries === "function") {
        for await (const [filename, handle] of options.directory.entries()) {
          if (handle?.kind !== "file" || filename === MANIFEST_FILENAME) continue;
          if (!legacyFilenameMatchesLesson(filename, options.lesson)) continue;
          const inspected = await inspectMediaFile(options.directory, filename);
          if (inspected) matches.push({ filename, ...inspected });
        }
      }
      if (!matches.length) return { status: "writable" };
      if (matches.length > 1 || !matches[0].valid) {
        return { status: "conflict", filename: matches[0].filename, bytes: matches[0].size };
      }
      const adopted = {
        lessonId,
        filename: matches[0].filename,
        bytes: matches[0].size,
        mediaType: MEDIA_TYPES[matches[0].extension],
        verified: true,
        completedAt: new Date().toISOString(),
      };
      await writeManifestUnlocked(options.directory, upsertLesson(manifest, adopted));
      return { status: "skipped", filename: adopted.filename, bytes: adopted.bytes };
    });
  }

  function hasCompletionEvidence(entry) {
    return entry?.verified === true
      && Boolean(String(entry.mediaType || "").trim())
      && Boolean(String(entry.completedAt || "").trim());
  }

  function completionEvidence(options, writeResult = {}) {
    const supplied = options.verification || {};
    const verified = writeResult.verified ?? supplied.verified ?? options.verified;
    const mediaType = writeResult.mediaType || supplied.mediaType || options.mediaType || options.lesson.mediaType;
    const duration = writeResult.duration ?? supplied.duration ?? options.duration;
    if (verified !== true) throw new Error("Commit requires verified media evidence");
    if (!String(mediaType || "").trim()) throw new Error("Commit requires verified mediaType evidence");
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 0)) {
      throw new Error("Commit duration evidence is invalid");
    }
    return {
      mediaType: String(mediaType).trim(),
      verified: true,
      completedAt: String(options.completedAt || writeResult.completedAt || supplied.completedAt || new Date().toISOString()),
      ...(duration === undefined ? {} : { duration }),
    };
  }

  function upsertLesson(manifest, record) {
    const owner = findFilenameOwner(manifest, record.filename);
    if (owner && owner.lessonId !== record.lessonId) {
      throw new Error(`Conflict: ${record.filename} is tracked by lesson ${owner.lessonId}`);
    }
    return {
      ...manifest,
      lessons: [...manifest.lessons.filter((entry) => entry.lessonId !== record.lessonId), record],
    };
  }

  async function prepareLessonFile(options) {
    requireIdentity(options);
    const initial = await withManifestLock(
      options,
      () => readManifestUnlocked(options.directory, options.courseId),
    );
    const initialEntry = findLesson(initial, options.lesson.lessonId);
    const filename = resolveFilename(options, initialEntry);
    return withFileLock(options, filename, () => withManifestLock(options, async () => {
      const manifest = await readManifestUnlocked(options.directory, options.courseId);
      const lessonId = options.lesson.lessonId;
      const entry = findLesson(manifest, lessonId);
      const existing = await fileInfo(options.directory, filename);

      if (entry
        && entry.filename === filename
        && existing?.size === entry.bytes
        && entry.bytes > 0
        && hasCompletionEvidence(entry)) {
        return { status: "skipped", filename, bytes: existing.size };
      }
      if (!existing) return { status: "writable", filename };
      if (existing.size === 0) {
        await removeIfPresent(options.directory, filename);
        return { status: "writable", filename };
      }
      return { status: "conflict", filename, bytes: existing.size };
    }));
  }

  async function commitLessonFile(options) {
    requireIdentity(options);
    const filename = resolveFilename(options);
    return withFileLock(options, filename, async () => {
      const initialManifest = await withManifestLock(
        options,
        () => readManifestUnlocked(options.directory, options.courseId),
      );
      const initialOwner = findFilenameOwner(initialManifest, filename);
      if (initialOwner && initialOwner.lessonId !== options.lesson.lessonId) {
        throw new Error(`Conflict: ${filename} is tracked by lesson ${initialOwner.lessonId}`);
      }

      const preexisting = await fileInfo(options.directory, filename);
      if (preexisting?.size > 0 && !options.overwrite) {
        throw new Error(`Conflict: ${filename} already exists`);
      }
      const createdByAttempt = !preexisting;
      let writable;
      let mediaClosed = false;
      let record;
      try {
        const handle = await options.directory.getFileHandle(filename, { create: true });
        writable = await handle.createWritable({ keepExistingData: false });
        let writeResult = {};
        if (typeof options.write === "function") {
          const callbackWritable = new Proxy(writable, {
            get(target, property) {
              if (property === "close") {
                return async () => { throw new Error("Commit callback must not close the writable"); };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          writeResult = await options.write(callbackWritable) || {};
        } else {
          await writable.write(options.data);
        }

        const reportedBytes = writeResult.bytesWritten;
        if (reportedBytes !== undefined && !Number.isSafeInteger(reportedBytes)) {
          throw new Error("Writer returned invalid bytesWritten");
        }
        if (options.expectedBytes !== undefined
          && reportedBytes !== undefined
          && options.expectedBytes !== reportedBytes) {
          throw new Error(`Expected ${options.expectedBytes} bytes but writer reported ${reportedBytes}`);
        }
        const expectedBytes = options.expectedBytes
          ?? reportedBytes
          ?? options.data?.byteLength;
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
          throw new Error("Commit requires positive expected bytes");
        }
        const evidence = completionEvidence(options, writeResult);
        if (typeof options.beforeClose === "function") {
          await options.beforeClose({
            filename,
            bytesWritten: expectedBytes,
            mediaType: evidence.mediaType,
          });
        }
        await writable.close();
        mediaClosed = true;
        const completed = await fileInfo(options.directory, filename);
        if (!completed || completed.size !== expectedBytes) {
          throw new Error(`Expected ${expectedBytes} bytes but wrote ${completed?.size ?? 0}`);
        }
        if (options.expectedMediaExtension) {
          const inspected = await inspectMediaFile(options.directory, filename);
          const expectedExtension = String(options.expectedMediaExtension).toLowerCase();
          if (!inspected?.valid || inspected.extension !== expectedExtension) {
            throw new Error("Written file is not valid media for the expected format");
          }
        }
        record = { lessonId: options.lesson.lessonId, filename, bytes: expectedBytes, ...evidence };
      } catch (error) {
        if (!mediaClosed) {
          try { await writable?.abort?.(); } catch {}
        }
        if (createdByAttempt) {
          try {
            await withManifestLock(options, async () => {
              const latest = await readManifestUnlocked(options.directory, options.courseId);
              if (!findFilenameOwner(latest, filename)) await removeIfPresent(options.directory, filename);
            });
          } catch {}
        }
        throw error;
      }

      await withManifestLock(options, async () => {
        const latest = await readManifestUnlocked(options.directory, options.courseId);
        await writeManifestUnlocked(options.directory, upsertLesson(latest, record));
      });
      return { status: "success", ...record };
    });
  }

  async function recoverCommittingLesson(options) {
    requireIdentity(options);
    if (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes <= 0) {
      throw new Error("Committing recovery requires positive expectedBytes");
    }
    const initial = await withManifestLock(
      options,
      () => readManifestUnlocked(options.directory, options.courseId),
    );
    const initialEntry = findLesson(initial, options.lesson.lessonId);
    const initialFilename = resolveFilename(options, initialEntry);
    return withFileLock(options, initialFilename, () => withManifestLock(options, async () => {
      const latest = await readManifestUnlocked(options.directory, options.courseId);
      const current = findLesson(latest, options.lesson.lessonId);
      const filename = resolveFilename({ ...options, filename: initialFilename }, current);
      const owner = findFilenameOwner(latest, filename);
      if (owner && owner.lessonId !== options.lesson.lessonId) {
        return { status: "conflict", filename, bytes: (await fileInfo(options.directory, filename))?.size || 0 };
      }
      const existing = await fileInfo(options.directory, filename);
      if (!existing) return { status: "writable", filename };
      if (existing.size === 0) {
        await removeIfPresent(options.directory, filename);
        return { status: "writable", filename };
      }
      if (existing.size !== options.expectedBytes) {
        return { status: "conflict", filename, bytes: existing.size };
      }

      const evidence = hasCompletionEvidence(current)
        ? {
          mediaType: current.mediaType,
          verified: true,
          completedAt: current.completedAt,
          ...(current.duration === undefined ? {} : { duration: current.duration }),
        }
        : completionEvidence(options);
      const record = { lessonId: options.lesson.lessonId, filename, bytes: existing.size, ...evidence };
      const alreadyRecorded = current
        && current.filename === record.filename
        && current.bytes === record.bytes
        && hasCompletionEvidence(current);
      if (!alreadyRecorded) await writeManifestUnlocked(options.directory, upsertLesson(latest, record));
      return { status: "success", filename, bytes: existing.size, recovered: true };
    }));
  }

  async function overwriteConflict(options) {
    requireIdentity(options);
    const initial = await withManifestLock(
      options,
      () => readManifestUnlocked(options.directory, options.courseId),
    );
    const initialEntry = findLesson(initial, options.lesson.lessonId);
    const initialFilename = resolveFilename(options, initialEntry);
    return withFileLock(options, initialFilename, () => withManifestLock(options, async () => {
      const latest = await readManifestUnlocked(options.directory, options.courseId);
      const current = findLesson(latest, options.lesson.lessonId);
      const filename = resolveFilename({ ...options, filename: initialFilename }, current);
      const owner = latest.lessons.find((entry) => (
        entry.lessonId !== options.lesson.lessonId && entry.filename === filename
      ));
      if (owner) throw new Error(`Conflict file is tracked by lesson ${owner.lessonId}`);

      await removeIfPresent(options.directory, filename);
      if (current) {
        await writeManifestUnlocked(options.directory, {
          ...latest,
          lessons: latest.lessons.filter((entry) => entry.lessonId !== options.lesson.lessonId),
        });
      }
      return { status: "writable", filename };
    }));
  }

  return {
    MANIFEST_FILENAME,
    buildBatchFilename,
    commitLessonFile,
    overwriteConflict,
    prepareLessonFile,
    readManifest,
    reconcileLessonFile,
    recoverCommittingLesson,
  };
});
