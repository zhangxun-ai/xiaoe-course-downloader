const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFilename,
  classifyMediaUrl,
  inferExtension,
  selectBestCandidate,
} = require("../shared/media-utils.js");

test("classifies direct media and HLS URLs while ignoring individual segments", () => {
  assert.deepEqual(
    classifyMediaUrl("https://cdn.example.com/course/lesson.mp4?token=abc"),
    { kind: "direct", extension: "mp4" },
  );
  assert.deepEqual(
    classifyMediaUrl("https://cdn.example.com/course/master.m3u8?token=abc"),
    { kind: "hls", extension: "m3u8" },
  );
  assert.equal(
    classifyMediaUrl("https://cdn.example.com/course/segment-001.ts"),
    null,
  );
  assert.equal(classifyMediaUrl("blob:https://course.example.com/id"), null);
});

test("selects the playlist instead of an HLS segment or unrelated resource", () => {
  const selected = selectBestCandidate([
    { url: "https://cdn.example.com/segment-001.ts", source: "network" },
    { url: "https://cdn.example.com/logo.png", mime: "image/png", source: "network" },
    { url: "https://cdn.example.com/master.m3u8", mime: "application/vnd.apple.mpegurl", source: "performance" },
  ]);

  assert.equal(selected.url, "https://cdn.example.com/master.m3u8");
  assert.equal(selected.kind, "hls");
});

test("uses MIME type when a signed media URL has no extension", () => {
  assert.equal(
    inferExtension({ url: "https://cdn.example.com/play?id=1", mime: "audio/mpeg" }),
    "mp3",
  );
  assert.equal(
    inferExtension({ url: "https://cdn.example.com/play?id=2", mime: "video/mp4" }),
    "mp4",
  );
});

test("builds a safe numbered filename", () => {
  assert.equal(
    buildFilename("  第1课：你好/世界?  ", "mp4", 1),
    "001-第1课 你好 世界.mp4",
  );
});

test("preserves a chapter number already present in the course title", () => {
  assert.equal(
    buildFilename("65. 体制内的思考", "mp3", 1),
    "65. 体制内的思考.mp3",
  );
});

test("preserves a numeric lesson marker without punctuation", () => {
  assert.equal(
    buildFilename("85 AI 的上游--数据清洁度", "ts", 1),
    "85 AI 的上游--数据清洁度.ts",
  );
});
