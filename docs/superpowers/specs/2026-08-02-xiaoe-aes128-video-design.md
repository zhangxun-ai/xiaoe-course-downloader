# 小鹅通 AES-128 视频下载设计

## 目标

让已登录 Edge 中的小鹅通课程下载器能够保存 AES-128 加密、已结束的 HLS 点播视频；单节和现有批量任务共用同一下载链路。

## 范围

- 支持 HLS `#EXT-X-KEY:METHOD=AES-128`，包括显式 IV 和按媒体序列号推导的 IV。
- 支持播放列表中密钥变更；每个分片携带当时有效的密钥信息。
- 密钥和解密后的分片仅保存在扩展内存中，使用当前浏览器登录会话请求。
- 保留现有的 MP4/未加密 HLS、命名、目录选择、断点任务与冲突保护逻辑。

## 非目标

- 不支持 DRM、`EXT-X-SESSION-KEY`、直播、任何 `EXT-X-BYTERANGE`（包括 `EXT-X-MAP` 属性）、样本级加密或独立音视频轨合并。
- 不尝试绕过登录或课程访问权限。
- 不新增外部程序、服务器或依赖。

## 数据流

1. `shared/hls.js` 将原有的 `resources: string[]` 迁移为按顺序的资源描述符：`{ url, kind: "media" | "map", keyUrl?, iv? }`。`loadHlsPlan` 和 `writeHlsResources` 同步改用该契约，未加密资源也使用描述符。
2. `#EXT-X-KEY:METHOD=NONE` 清除当前密钥。AES-128 必须有相对播放列表 URL 解析后的 HTTP(S) `URI`；拒绝缺失 URI、未知 METHOD 及非 `identity` 的 KEYFORMAT。
3. 缺省 IV 使用 `EXT-X-MEDIA-SEQUENCE`（缺省 0）编码为 128 位无符号大端数，并且只随媒体分片递增。加密播放列表若包含 `EXT-X-MAP`，第一版要求该 map 有显式 IV；否则拒绝，避免把未解密的初始化数据写入 MP4。
4. `shared/download-core.js` 缓存同一 URL 的 16 字节密钥；以 `fetch(..., { credentials: "include" })` 获取密钥与分片，并拒绝非 HTTP(S) 的密钥或分片 URL。
5. 对有密钥的分片，先完整读取密文（非空且长度为 16 的倍数），用注入的 Web Crypto `AES-CBC` 解密后写入；无密钥分片保持流式直写。进度和 `bytesWritten` 统计实际写入的明文。
6. 任何获取、解密或写入失败都 abort 当前文件写入、不关闭为成功。HLS 分片也增加与直链一致的 HTML/JSON 响应拒绝。批量路径随后走现有媒体头校验、原子提交与 manifest 记录；单节路径沿用其现有的直接保存与成功状态展示，不假称拥有 batch manifest 或原子提交。

## 失败处理

- 密钥请求失败、长度不是 16 字节、IV 格式错误、密文长度不合规或解密失败：中止当前文件写入并保留任务为失败；不会写入完成 manifest。
- 同一密钥 URL 在同一任务内只请求一次；失败不将错误密钥缓存为成功结果。
- 未覆盖的 HLS 特性仍在解析阶段给出明确错误。

## 验证

- 单元测试覆盖 AES-128 显式 IV、隐式序列 IV、相对密钥 URI、密钥轮换、`METHOD=NONE`、加密 map、map BYTERANGE 和未知加密方法拒绝。
- 下载核心以注入的 `crypto.subtle`（或解密函数）使用已知 AES-CBC/PKCS#7 密文夹具，验证分片会在写入前被解密、密钥只获取一次、密钥错误会 abort 且不关闭为成功。
- 保留未加密 HLS 测试，证明原音频流程不回归。
- 人工测试：在 Edge 已登录状态下下载第 76 节单个视频，确认生成的视频可播放；然后用“只测试前三节”验证批量路径。
