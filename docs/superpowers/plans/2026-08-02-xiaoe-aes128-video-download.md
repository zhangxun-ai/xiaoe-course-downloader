# 小鹅通 AES-128 视频下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已登录 Edge 中下载 AES-128 加密的小鹅通 HLS 点播视频，供单节与批量课程复用。

**Architecture:** HLS 解析器把分片 URL 升级为含密钥和 IV 的有序描述符。下载核心获取并缓存密钥，对加密分片在内存中用 Web Crypto AES-CBC 解密后写入；调用方和文件提交逻辑保持不变。

**Tech Stack:** Manifest V3、浏览器 Web Crypto、Fetch、Node 内置测试运行器。

---

### Task 1: 建立 AES-128 播放列表契约

**Files:**
- Modify: `shared/hls.js`
- Test: `tests/hls.test.cjs`

- [ ] **Step 1: 写失败的解析测试**

覆盖显式/隐式 IV、相对 key URI、METHOD=NONE、密钥轮换、加密 map 的显式 IV 要求及 map BYTERANGE 拒绝；也覆盖缺失 key URI、非 HTTP(S) key/分片 URI、未知 METHOD、非 identity KEYFORMAT、畸形 IV，以及 MEDIA-SEQUENCE 仅随媒体分片（不随 map）递增。

- [ ] **Step 2: 运行解析测试确认失败**

Run: `node --test tests/hls.test.cjs`
Expected: FAIL，因为当前解析器拒绝 AES-128 且输出 `string[]`。

- [ ] **Step 3: 最小化实现描述符解析**

将 `resources` 改为 `{ url, kind, keyUrl?, iv? }[]`；只允许 HTTP(S) URI，正确处理 KEY、MEDIA-SEQUENCE 和 MAP。

- [ ] **Step 4: 运行解析测试确认通过**

Run: `node --test tests/hls.test.cjs`
Expected: PASS。

### Task 2: 解密后写入 HLS 分片

**Files:**
- Modify: `shared/download-core.js`
- Test: `tests/download-core.test.cjs`

- [ ] **Step 1: 写失败的下载测试**

用固定 AES-CBC/PKCS#7 密文验证写入明文、同 key 在一次 `writeHlsResources` 调用内只取一次、解密失败 abort；验证失败的 key 请求不会缓存。覆盖非 16 字节 key、非空但长度不是 16 倍数的密文、非 HTTP(S) 分片 URL 与 HLS 分片返回 HTML/JSON 的拒绝；保留未加密 HLS 兼容测试。

- [ ] **Step 2: 运行下载测试确认失败**

Run: `node --test tests/download-core.test.cjs`
Expected: FAIL，因为当前只把资源 URL 流式拼接。

- [ ] **Step 3: 最小化实现密钥缓存与 AES-CBC 解密**

向 `writeHlsResources` 注入 crypto 实现，安全请求 key，验证密文长度并在写入前解密；所有失败沿用 writable abort。

- [ ] **Step 4: 运行下载测试确认通过**

Run: `node --test tests/download-core.test.cjs`
Expected: PASS。

### Task 3: 连接单节与批量调用方并验证

**Files:**
- Modify: `shared/download-core.js`（仅兼容层，如需要）
- Modify: `tests/batch-runner-core.test.cjs`（仅实际契约变化所需）
- Modify: `README.md`

- [ ] **Step 1: 运行现有批量相关测试确认契约失败点**

Run: `node --test tests/batch-runner-core.test.cjs tests/download-core.test.cjs`
Expected: 若旧资源数组契约仍有调用方则失败。

- [ ] **Step 2: 做最小调用方兼容改动**

确保 `loadHlsPlan` 返回的新描述符可由单节 `downloader.js` 与批量 `batch-runner-core.js` 的现有 `plan.write` 使用；更新 README 的 AES-128 限制说明。

- [ ] **Step 3: 运行完整针对性验证**

Run: `npm test`
Expected: PASS，且不回归音频、未加密 HLS、文件提交和批量恢复测试。

- [ ] **Step 4: Edge 手工验证**

重新加载扩展，在第 76 节选择空目录下载；确认文件可播放。成功后用“只测试前三节”验证批量视频路径。
