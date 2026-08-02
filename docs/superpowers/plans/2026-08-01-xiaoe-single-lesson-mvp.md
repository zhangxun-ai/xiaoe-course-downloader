# Xiaoetong Single-Lesson Downloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent Chrome/Edge MV3 extension that downloads one accessible Xiaoetong lesson to a user-selected directory with a sanitized course-title filename.

**Architecture:** A background observer and an on-demand page scanner collect media candidates for the current tab. The popup creates one stored job, and a persistent downloader page writes either a direct media response or an unencrypted HLS stream through the File System Access API.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JavaScript, File System Access API, `chrome.webRequest`, `chrome.scripting`, Node built-in test runner.

---

Implementation stays inside `xiaoe-course-downloader/`. No commits are included because the user authorized implementation but did not authorize committing.

### Task 1: Pure media utilities

**Files:**
- Create: `xiaoe-course-downloader/shared/media-utils.js`
- Create: `xiaoe-course-downloader/tests/media-utils.test.cjs`
- Create: `xiaoe-course-downloader/package.json`

- [ ] Write failing tests for URL classification, candidate ranking, extension inference and filename sanitation.
- [ ] Run `npm test` from `xiaoe-course-downloader/` and verify the missing module fails.
- [ ] Implement a browser/Node-compatible utility module with `classifyMediaUrl`, `scoreCandidate`, `selectBestCandidate`, `inferExtension`, and `buildFilename`.
- [ ] Run `npm test` and verify the utility tests pass.

### Task 2: Minimal HLS parser

**Files:**
- Create: `xiaoe-course-downloader/shared/hls.js`
- Create: `xiaoe-course-downloader/tests/hls.test.cjs`

- [ ] Write failing tests for master-playlist variant selection, relative media segment resolution, `EXT-X-MAP`, output-extension inference, and rejection of encryption, byte ranges, session keys, and live/non-final playlists.
- [ ] Run `npm test` and verify the missing module fails.
- [ ] Implement pure HLS parsing helpers that select the highest-bandwidth variant, return ordered resource URLs and choose `.ts`, `.aac`, or `.mp4` for a supported unencrypted VOD playlist.
- [ ] Run `npm test` and verify all parser tests pass.

### Task 3: Extension capture and job creation

**Files:**
- Create: `xiaoe-course-downloader/manifest.json`
- Create: `xiaoe-course-downloader/background.js`
- Create: `xiaoe-course-downloader/content-scripts/page-scanner.js`
- Create: `xiaoe-course-downloader/popup.html`
- Create: `xiaoe-course-downloader/popup.css`
- Create: `xiaoe-course-downloader/popup.js`

- [ ] Add the MV3 manifest with `activeTab`, `scripting`, `storage`, and `webRequest` permissions plus `<all_urls>` host access for Xiaoetong CDN discovery/fetching; do not request the unnecessary `tabs` permission.
- [ ] Implement a background observer that records bounded media candidates per tab in `chrome.storage.session`, clears them on top-level navigation/tab close, and never stores media bodies.
- [ ] Implement the on-demand page scanner for media elements, metadata, headings and performance resources.
- [ ] Implement the popup flow that merges candidates, displays the selected result, stores one ephemeral session job and opens `downloader.html?jobId=...`.
- [ ] Add a static manifest/reference test and run `npm test`.

### Task 4: Single-file downloader page

**Files:**
- Create: `xiaoe-course-downloader/downloader.html`
- Create: `xiaoe-course-downloader/downloader.css`
- Create: `xiaoe-course-downloader/downloader.js`

- [ ] Load and validate the stored session job, delete it immediately after reading, and show its page title and detected media type.
- [ ] Add a user-triggered `showDirectoryPicker()` flow and create a sanitized output file.
- [ ] Implement direct-response streaming with `credentials: "include"`, byte progress and abort-on-error; surface 401/403 as an authentication/referrer limitation.
- [ ] Implement sequential HLS writing by fetching the selected media playlist and its ordered resources, using the parser-selected media container extension.
- [ ] Report completion only after a positive byte count and successful writable close; otherwise show a specific recoverable error.
- [ ] Run `npm test` and a JavaScript syntax check for every extension script.

### Task 5: Documentation and browser handoff

**Files:**
- Create: `xiaoe-course-downloader/README.md`

- [ ] Document loading the unpacked extension in Edge/Chrome and explain the broad host permission.
- [ ] Document the exact single-lesson test: log in, open a lesson, play 3–5 seconds, click the extension, inspect, download, and verify playback.
- [ ] Document current limitations: one lesson, sequential HLS, no DRM/encrypted HLS, no batch/concurrency.
- [ ] Run the full focused test command and inspect `git diff -- xiaoe-course-downloader` before completion.
