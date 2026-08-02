# Incremental Course Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse valid existing course audio, clean stale manifest entries, and download only missing lessons without accepting HTML pages as media.

**Architecture:** The scanner will reject empty media attributes. The downloader will reject HTML/JSON responses before writing them. Batch-file reconciliation is scoped by `courseId + lessonId`, then adopts one uniquely matching valid legacy audio file by exact lesson number and normalized title. A download is committed to the manifest only after the writable closes and the stored file header validates as media.

**Tech Stack:** Manifest V3 extension, browser File System Access API, CommonJS Node tests.

---

### Task 1: Prevent false media candidates and HTML downloads

**Files:**
- Modify: `content-scripts/page-scanner.js`
- Modify: `shared/download-core.js`
- Create: `tests/page-scanner.test.cjs`
- Modify: `tests/download-core.test.cjs`

- [ ] **Step 1: Write failing scanner test**

Run the page scanner in a VM with an `audio` element whose `src` and `currentSrc` are empty. Assert that the current page URL is not emitted as a media candidate.

- [ ] **Step 2: Verify scanner test fails**

Run: `node --test tests/page-scanner.test.cjs`

- [ ] **Step 3: Reject blank scanner attributes**

Require a non-empty URL before resolving it against `location.href`.

- [ ] **Step 4: Write failing HTML-response test**

Pass a `text/html` response to `writeDirectMedia`. Assert rejection and writable abort without any successful commit.

- [ ] **Step 5: Verify downloader test fails**

Run: `node --test --test-name-pattern="HTML" tests/download-core.test.cjs`

- [ ] **Step 6: Reject obvious non-media response MIME types**

Reject `text/html`, JSON, and other `text/*` direct-media responses before streaming bytes.

- [ ] **Step 7: Verify task tests pass**

Run: `node --test tests/page-scanner.test.cjs tests/download-core.test.cjs`

### Task 2: Reconcile the selected directory with the manifest

**Files:**
- Modify: `shared/batch-files.js`
- Modify: `tests/batch-files.test.cjs`

- [ ] **Step 1: Write failing reconciliation tests**

Cover: missing manifest file removes the stale record; valid legacy `87. Title.mp3` and `87-Title.mp3` are adopted for lesson `87. Title`; `8` never matches `87`; invalid completed file becomes a conflict; ambiguous files remain conflicts.

- [ ] **Step 2: Verify reconciliation tests fail**

Run: `node --test --test-name-pattern="adopt|stale|invalid|ambiguous" tests/batch-files.test.cjs`

- [ ] **Step 3: Add audio-file signature helpers**

Recognize MP3 (`ID3` or frame sync), M4A/MP4 (`ftyp`), WAV, FLAC, OGG, and ADTS AAC from the first bytes.

- [ ] **Step 4: Add `reconcileLessonFile`**

Under existing `courseId + lessonId` manifest and file locks: skip verified audio in the manifest, remove records for missing or invalid completed files, preserve any invalid non-empty file as a conflict, and adopt a unique exact number/title legacy audio file.

- [ ] **Step 5: Verify reconciliation tests pass**

Run: `node --test tests/batch-files.test.cjs`

### Task 3: Use reconciliation before resolving or downloading

**Files:**
- Modify: `shared/batch-runner-core.js`
- Modify: `tests/batch-runner-core.test.cjs`

- [ ] **Step 1: Write a failing runner test**

Make `reconcileLessonFile` return `skipped`; assert that the resolver and downloader are never called.

- [ ] **Step 2: Verify runner test fails**

Run: `node --test --test-name-pattern="reconciled" tests/batch-runner-core.test.cjs`

- [ ] **Step 3: Reconcile before resolver invocation**

Return skip/conflict outcomes immediately; only resolve media for lessons reconciled as writable. Probe the incoming media signature before writing; after the writable closes, validate the stored file header and only then add its `courseId + lessonId` completion record.

- [ ] **Step 4: Verify runner tests pass**

Run: `node --test tests/batch-runner-core.test.cjs`

### Task 4: Verify and reload for the user

**Files:**
- Verify: `content-scripts/page-scanner.js`, `shared/download-core.js`, `shared/batch-files.js`, `shared/batch-runner-core.js`

- [ ] **Step 1: Run the necessary focused suite**

Run: `node --check content-scripts/page-scanner.js && node --check shared/download-core.js && node --check shared/batch-files.js && node --check shared/batch-runner-core.js && node --test tests/page-scanner.test.cjs tests/download-core.test.cjs tests/batch-files.test.cjs tests/batch-runner-core.test.cjs`

- [ ] **Step 2: Reload the unpacked extension**

Reload from `edge://extensions`; do not touch Tampermonkey or CatCatch.

- [ ] **Step 3: User test**

On the course page, choose the existing target directory and start all downloads. Expected: the 24 valid legacy MP3 files are skipped/adopted, 1–63 and 67 become pending downloads, and no `.bin` or duplicate `87.`/`88.` files are created.
