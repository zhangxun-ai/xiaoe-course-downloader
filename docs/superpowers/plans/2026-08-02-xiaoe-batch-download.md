# Xiaoetong Batch Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the independent extension so one click on the current Xiaoetong course page discovers all 88 catalog lessons, asks for one directory, and downloads the selected lessons with calibration, concurrency 2, deterministic names, retries, recovery, and completion tracking.

**Architecture:** A MAIN-world catalog scanner reads the observed Xiaoetong Vue component and loads every page until `columnList.length === total`. A persistent batch runner owns the queue and directory handle, opens bounded inactive lesson tabs just in time, reuses the proven media scanner/downloader, and persists only lesson/job state—not signed media URLs.

**Tech Stack:** Chrome/Edge Extension Manifest V3, vanilla JavaScript, `chrome.scripting` MAIN/ISOLATED worlds, `chrome.tabs`, File System Access API, IndexedDB, Web Locks, Node built-in test runner.

---

Implementation stays inside `xiaoe-course-downloader/`. The parent repository is dirty and the extension directory is itself isolated/untracked, so this plan does not create a worktree or commit without explicit Git authorization.

## Verified Xiaoetong Fixture

Read-only inspection on 2026-08-02 established these current-page facts:

- Detail URL host/path: `*.xet-pc.citv.cn/p/t_pc/course_pc_detail/audio/...?...product_id=...`
- Catalog tab renders `.column_catalog` whose root has a Vue 2 `__vue__` instance.
- Component fields/methods: `total=88`, `pageSize=20`, `pageIndex`, `columnList`, `loadMoreCourse()`, `showLoading`.
- One `loadMoreCourse()` changes the eventual list length from 20 to 40 after the asynchronous request settles.
- Each list item exposes `resource_id`, `resource_title`, `resource_type`, `jump_url`, `can_view`, `is_try`, and related metadata.
- Current audio detail page exposes a direct Tencent Cloud MP3 in `<audio src>` without requiring a trusted playback gesture.

The implementation must sanitize fixtures and never store authentication cookies, request headers, or signed media URLs in tests/docs.

### Task 1: Catalog snapshot normalization

**Files:**
- Create: `shared/catalog.js`
- Create: `tests/catalog.test.cjs`
- Create: `tests/fixtures/xiaoe-catalog-snapshot.json`

- [ ] Write failing tests for `normalizeCatalogSnapshot(snapshot, pageUrl)` using a three-item sanitized fixture with `total`, `product_id`, `resource_id`, `resource_title`, `resource_type`, `jump_url`, `can_view`, and `is_try`.
- [ ] Assert exact count, URL resolution against `location.origin`, duplicate `resource_id` rejection, missing title/link rejection, and preservation of titles such as `65. 体制内的思考`.
- [ ] Define the verified accessibility mapping: this purchased course exposes `can_view=0` for a currently playable item, so `can_view` must not be treated as locked. A lesson is initially selectable when it has a valid `jump_url`; retain `can_view/is_try` only for diagnostics and let the media resolver make the final access decision. Test selectable `can_view=0`, trial metadata, and missing-`jump_url` disabled behavior.
- [ ] Run `node --test tests/catalog.test.cjs`; expect module-not-found failure.
- [ ] Implement browser/Node UMD exports: `normalizeCatalogSnapshot`, `validateCompleteCatalog`, `extractProductId`, and `parseLessonNumber`.
- [ ] Require normalized unique length to equal declared `total`; do not silently accept partial catalogs.
- [ ] Re-run focused tests and expect all catalog tests to pass.

### Task 2: MAIN-world complete catalog scanner

**Files:**
- Create: `shared/catalog-loader.js`
- Create: `content-scripts/catalog-scanner.js`
- Create: `tests/catalog-loader.test.cjs`
- Create: `tests/catalog-scanner-contract.test.cjs`
- Modify: `tests/extension-structure.test.cjs`

- [ ] Write failing `catalog-loader` tests with a fake Vue adapter for `20→40→60→80→88`, `showLoading`, duplicate pages, no growth, count overflow/underflow, and one 15-second timeout budget per requested page.
- [ ] Write a static/contract test that requires the scanner to reference `.column_catalog`, `__vue__`, `loadMoreCourse`, `total`, and `columnList`, and forbids serializing cookies/localStorage.
- [ ] Run the focused tests and observe missing-module/file failures.
- [ ] Implement pure `loadCompleteCatalog(adapter, {perPageTimeoutMs, pollIntervalMs})` in `shared/catalog-loader.js`, with injected `now/sleep` for deterministic tests. It must re-read list length after each async load, reject duplicates/no-growth/overflow, and require final length exactly `total`.
- [ ] Implement an async IIFE for `chrome.scripting.executeScript({ world: "MAIN" })` that:
  - finds `.column_catalog.__vue__` after a bounded wait;
  - records `total`, `pageSize`, and the sanitized list fields;
  - calls `loadMoreCourse()` one page at a time;
  - waits until `columnList.length` grows or loading ends;
  - delegates pagination to `XiaoeCatalogLoader` and applies a fresh 15-second timeout to each requested page;
  - returns a plain structured-cloneable snapshot without Vue objects or credentials.
- [ ] Add the scanner to extension reference tests and run all catalog tests.

### Task 3: Batch job state machine and scheduler

**Files:**
- Create: `shared/batch-state.js`
- Create: `shared/batch-scheduler.js`
- Create: `shared/job-store.js`
- Create: `tests/batch-state.test.cjs`
- Create: `tests/batch-scheduler.test.cjs`
- Create: `tests/job-store.test.cjs`

- [ ] Write failing state tests for job creation, counts, legal transitions, attempt tokens, recovery of `resolving/downloading/committing` to `pending`, and terminal `success/skipped/failed/conflict` states.
- [ ] Write failing scheduler tests for: first `min(3, unfinished)` tasks serial; all-manifest-verified jobs perform no calibration; calibration failure stops expansion; calibration success permits at most 2 concurrent tasks; stop prevents new dispatch; retries discard media URLs and stop after 2 retries.
- [ ] Write failing job-store tests for: session draft creation; full job persistence plus `batchJobIndex:<courseId>`; checkpoint persistence without a course index; resume lookup by matching courseId/fingerprint; and idempotent deletion of job state, matching index, and directory-handle reference.
- [ ] Run focused tests and confirm missing-module failures.
- [ ] Implement pure UMD state/scheduler modules with no Chrome/DOM dependencies. Scheduler accepts injected `runLesson(task, attemptToken)` and `persist(job)` callbacks. Implement job-store with injected session/local/handle-store adapters so lifecycle behavior is testable without Chrome.
- [ ] Re-run state/scheduler tests and verify deterministic fake-clock/fake-worker behavior.

### Task 4: Directory handle, manifest, and deterministic file policy

**Files:**
- Create: `shared/directory-store.js`
- Create: `shared/batch-files.js`
- Create: `tests/batch-files.test.cjs`

- [ ] Write failing tests with fake directory/file handles for: manifest match => skipped; missing file => writable target; zero-byte untracked file => remove/redownload; nonzero untracked file => conflict; failed write => cleanup; committing recovery by expected byte size; explicit conflict overwrite.
- [ ] Add a concurrent-commit test that starts two successful lessons together and proves both lesson records remain in the final manifest; the later close must not overwrite the earlier record.
- [ ] Add filename/manifest safety cases: `65. 体制内的思考.mp3` never gains another prefix; illegal filename characters are sanitized; malformed manifest JSON, wrong `courseId`, or duplicate `lessonId` fails safely and never skips a media file.
- [ ] Run focused tests and confirm failure because the module is absent.
- [ ] Implement IndexedDB helpers to save/load a structured-cloneable `FileSystemDirectoryHandle` by `jobId`, with `queryPermission/requestPermission` at use time.
- [ ] Implement `.xiaoe-batch-manifest.json` read/validate/full-rewrite through `createWritable({keepExistingData:false})` and close-before-success semantics. Serialize every manifest read-modify-write with a job-scoped commit queue/Web Lock (`xiaoe-manifest:<jobId>`), re-reading the latest manifest only after acquiring the lock.
- [ ] Implement `prepareLessonFile`, `commitLessonFile`, `recoverCommittingLesson`, and `overwriteConflict` without changing the existing single-download `(2)` policy.
- [ ] Re-run focused and full tests.

### Task 5: Just-in-time inactive-tab media resolver

**Files:**
- Create: `shared/tab-resolver.js`
- Create: `tests/tab-resolver.test.cjs`
- Modify: `background.js`
- Modify: `content-scripts/page-scanner.js`

- [ ] Write failing pure resolver tests for navigation epoch, candidate scoping by tabId, direct DOM candidate preference, stale candidate rejection, 15-second timeout, and guaranteed tab close.
- [ ] Run focused tests and confirm missing-module failure.
- [ ] Implement injected orchestration helpers in `shared/tab-resolver.js`; keep Chrome API calls in the batch runner/background adapter.
- [ ] Extend background messages so the runner can clear/read candidates scoped to the created tab and current navigation start time.
- [ ] Ensure the page scanner returns the observed `<audio src>` immediately without `play()`; retain video/HLS behavior.
- [ ] Resolve each lesson by creating an inactive tab at normalized `jump_url`, waiting for complete, polling scanner/network candidates, selecting one unique media candidate, and closing the tab in `finally`.
- [ ] Never persist the selected signed media URL. Each retry calls the resolver again.
- [ ] Run resolver and existing media tests.

### Task 6: Batch runner UI and popup entry

**Files:**
- Create: `shared/batch-runner-core.js`
- Create: `tests/batch-runner-core.test.cjs`
- Create: `batch-runner.html`
- Create: `batch-runner.css`
- Create: `batch-runner.js`
- Modify: `popup.html`
- Modify: `popup.css`
- Modify: `popup.js`
- Modify: `manifest.json`
- Modify: `tests/extension-structure.test.cjs`

- [ ] Write a failing runner-core integration test with fake storage, directory, resolver and downloader. Cover: directory selection exactly once; persist-before-side-effect; three-item serial calibration then concurrency 2; stop; stale attempt-token callback ignored; and duplicate runner lock returning read-only mode.
- [ ] Implement `shared/batch-runner-core.js` as the dependency-injected orchestrator joining scheduler, resolver, file policy and persistence. Keep DOM and Chrome APIs out of this module.
- [ ] Update structure tests to require batch runner files and the unchanged minimum permission set; run and observe missing references.
- [ ] Add popup action “识别整个专栏”. Execute `shared/catalog-loader.js` plus `catalog-scanner.js` in MAIN world, normalize with `shared/catalog.js`, compute a stable catalog fingerprint, and first check `batchJobIndex:<courseId>`. Reopen a matching unfinished runner; otherwise create only an ephemeral session draft and open the preview.
- [ ] In preview, primary “开始全部下载” persists/indexes the full job. Secondary “只测试前三节” persists a separate checkpoint job containing exactly three selected lessons and no course index, then runs it in the same runner. Test “close full runner → click extension → resume same job”.
- [ ] After a checkpoint finishes, show “清理测试任务”; call the tested idempotent job-store deletion to remove local job state and IndexedDB directory handle reference. Full jobs do not expose automatic deletion while unfinished.
- [ ] Build preview UI showing title, total, first/last lesson, checkboxes, and validation errors. Default-select all valid lessons.
- [ ] On the single start button, call `showDirectoryPicker()` once, persist the handle, acquire `navigator.locks` for the job, reconcile the directory manifest, and start the scheduler.
- [ ] Render per-lesson state and aggregate pending/resolving/downloading/committing/success/skipped/failed/conflict counts.
- [ ] Implement “停止任务”, “重试失败项”, and explicit “覆盖冲突项并重新下载”. A second runner for the same job is read-only.
- [ ] Integrate the existing direct/HLS download core with per-task byte progress. Update storage before side effects and after every transition.
- [ ] Update static reference tests and run the full unit suite.

### Task 7: Browser-supported media verification and recovery

**Files:**
- Create: `shared/media-verifier.js`
- Create: `tests/media-verifier.test.cjs`
- Modify: `batch-runner.js`

- [ ] Write failing pure tests for format eligibility and verification result normalization; keep actual media-element behavior behind an injected loader.
- [ ] Implement object-URL metadata verification for MP3/M4A/MP4/WebM/WAV/AAC with a bounded timeout and `URL.revokeObjectURL` in `finally`.
- [ ] Move task to `committing` before closing the media writable; then verify file size/media metadata, update directory manifest, and finally mark `success`.
- [ ] On startup, reconcile `committing` tasks using expected bytes, actual size, verification, and directory manifest.
- [ ] Run focused and full tests.

### Task 8: Documentation, complete verification, and three-lesson live checkpoint

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-02-xiaoe-batch-download-design.md` only if verified site behavior requires a documented correction.

- [ ] Document the real workflow: open any lesson in this 88-item column, open 目录, click extension, verify total/first/last, choose one folder, and start.
- [ ] Run `npm test` and require zero failures.
- [ ] Run `node --check` over every extension JavaScript file.
- [ ] Parse `manifest.json` and verify every referenced file exists.
- [ ] Inspect `git status --short` and confirm changes remain inside `xiaoe-course-downloader/` apart from pre-existing parent changes.
- [ ] Reload the existing unpacked extension in Edge.
- [ ] Use the implemented preview action to create a dedicated checkpoint job containing exactly the first three selected lessons, concurrency 1, and no `batchJobIndex:<courseId>` entry. Use a newly created temporary folder and confirm exact names, nonzero sizes, local playback, queue counts, and no manual lesson interaction.
- [ ] After recording results, delete the checkpoint job/storage/indexed directory handle and remove only the explicitly created temporary checkpoint folder. The checkpoint state must not be reused by a permanent job.
- [ ] Do not start the full 88-item download automatically. Report the three-lesson checkpoint as exactly that—not as proof of full-column completion—and request explicit user authorization for the permanent-directory/full-column acceptance run.

### Task 9: User-authorized full-column acceptance

**Files:**
- Modify: `README.md` only if the full run reveals a verified operational correction.

- [ ] Proceed only after the user explicitly identifies/chooses the permanent directory and authorizes the complete 88-item run.
- [ ] Re-scan and validate the complete catalog, then create a new permanent all-selected job and `batchJobIndex:<courseId>` entry for the user-selected permanent directory. Do not reuse the deleted three-lesson checkpoint job.
- [ ] Verify `success + manifest-verified skipped + failed + conflict === selected` throughout and require `failed === 0` and `conflict === 0` before claiming completion.
- [ ] Verify every manifest entry maps to an existing file with matching size; automatically check metadata/duration for browser-supported media and manually sample first/middle/last playback.
- [ ] If user authorization is not provided in this implementation turn, stop after Task 8 with the extension implemented and the full-column outcome explicitly unverified.
