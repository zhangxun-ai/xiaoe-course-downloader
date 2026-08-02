const test = require("node:test");
const assert = require("node:assert/strict");

const { parseHlsPlaylist } = require("../shared/hls.js");

function bytes(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function playlist(lines) {
  return lines.join("\n");
}

test("selects the highest-bandwidth variant from a master playlist", () => {
  const result = parseHlsPlaylist(
    playlist(["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=64000", "audio/low.m3u8", "#EXT-X-STREAM-INF:BANDWIDTH=256000", "audio/high.m3u8"]),
    "https://cdn.example.com/course/master.m3u8",
  );
  assert.deepEqual(result, {
    kind: "master",
    variantUrl: "https://cdn.example.com/course/audio/high.m3u8",
  });
});

test("resolves a finalized MPEG-TS media playlist", () => {
  const result = parseHlsPlaylist(
    playlist(["#EXTM3U", "#EXTINF:10,", "seg-001.ts", "#EXTINF:8,", "seg-002.ts?token=abc", "#EXT-X-ENDLIST"]),
    "https://cdn.example.com/course/index.m3u8",
  );
  assert.deepEqual(result, {
    kind: "media",
    extension: "ts",
    resources: [
      { url: "https://cdn.example.com/course/seg-001.ts", kind: "media" },
      { url: "https://cdn.example.com/course/seg-002.ts?token=abc", kind: "media" },
    ],
  });
});

test("places an fMP4 initialization segment before media segments", () => {
  const result = parseHlsPlaylist(
    playlist(["#EXTM3U", "#EXT-X-MAP:URI=\"init.mp4\"", "#EXTINF:5,", "part-001.m4s", "#EXTINF:5,", "part-002.m4s", "#EXT-X-ENDLIST"]),
    "https://cdn.example.com/course/index.m3u8",
  );
  assert.equal(result.extension, "mp4");
  assert.deepEqual(result.resources, [
    { url: "https://cdn.example.com/course/init.mp4", kind: "map" },
    { url: "https://cdn.example.com/course/part-001.m4s", kind: "media" },
    { url: "https://cdn.example.com/course/part-002.m4s", kind: "media" },
  ]);
});

test("uses AAC for an audio-only media playlist", () => {
  const result = parseHlsPlaylist(
    playlist(["#EXTM3U", "#EXTINF:5,", "audio-001.aac", "#EXT-X-ENDLIST"]),
    "https://cdn.example.com/course/index.m3u8",
  );
  assert.equal(result.extension, "aac");
});

test("parses AES-128 media segments with explicit IV and a relative key URI", () => {
  const result = parseHlsPlaylist(
    playlist(["#EXTM3U", "#EXT-X-KEY:METHOD=AES-128,URI=\"keys/course.key\",IV=0x000102030405060708090a0b0c0d0e0f", "#EXTINF:5,", "seg-001.ts", "#EXT-X-ENDLIST"]),
    "https://cdn.example.com/course/index.m3u8",
  );
  assert.deepEqual(result.resources, [{
    url: "https://cdn.example.com/course/seg-001.ts",
    kind: "media",
    keyUrl: "https://cdn.example.com/course/keys/course.key",
    iv: bytes("000102030405060708090a0b0c0d0e0f"),
  }]);
});

test("derives AES-128 IV from media sequence and does not increment it for map", () => {
  const result = parseHlsPlaylist(
    playlist(["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:7", "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"", "#EXT-X-MAP:URI=\"init.mp4\",IV=0x00000000000000000000000000000007", "#EXTINF:5,", "first.m4s", "#EXTINF:5,", "second.m4s", "#EXT-X-ENDLIST"]),
    "https://cdn.example.com/course/index.m3u8",
  );
  assert.deepEqual(result.resources.map((resource) => ({
    ...resource,
    iv: Buffer.from(resource.iv).toString("hex"),
  })), [
    { url: "https://cdn.example.com/course/init.mp4", kind: "map", keyUrl: "https://cdn.example.com/course/key.bin", iv: "00000000000000000000000000000007" },
    { url: "https://cdn.example.com/course/first.m4s", kind: "media", keyUrl: "https://cdn.example.com/course/key.bin", iv: "00000000000000000000000000000007" },
    { url: "https://cdn.example.com/course/second.m4s", kind: "media", keyUrl: "https://cdn.example.com/course/key.bin", iv: "00000000000000000000000000000008" },
  ]);
});

test("supports key rotation and METHOD=NONE", () => {
  const result = parseHlsPlaylist(
    playlist(["#EXTM3U", "#EXT-X-KEY:METHOD=AES-128,URI=\"first.key\"", "#EXTINF:5,", "one.ts", "#EXT-X-KEY:METHOD=AES-128,URI=\"second.key\",IV=0x0000000000000000000000000000000f", "#EXTINF:5,", "two.ts", "#EXT-X-KEY:METHOD=NONE", "#EXTINF:5,", "three.ts", "#EXT-X-ENDLIST"]),
    "https://cdn.example.com/course/index.m3u8",
  );
  assert.equal(result.resources[0].keyUrl, "https://cdn.example.com/course/first.key");
  assert.equal(Buffer.from(result.resources[0].iv).toString("hex"), "00000000000000000000000000000000");
  assert.equal(result.resources[1].keyUrl, "https://cdn.example.com/course/second.key");
  assert.equal(result.resources[2].keyUrl, undefined);
  assert.equal(result.resources[2].iv, undefined);
});

for (const [name, lines, expectedMessage] of [
  ["session keys", ["#EXTM3U", "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"key.bin\"", "#EXTINF:5,", "seg.ts", "#EXT-X-ENDLIST"], "SESSION-KEY"],
  ["byte ranges", ["#EXTM3U", "#EXTINF:5,", "#EXT-X-BYTERANGE:1000@0", "media.ts", "#EXT-X-ENDLIST"], "BYTERANGE"],
  ["map byte ranges", ["#EXTM3U", "#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100@0\"", "#EXTINF:5,", "seg.m4s", "#EXT-X-ENDLIST"], "BYTERANGE"],
  ["AES-128 without a key URI", ["#EXTM3U", "#EXT-X-KEY:METHOD=AES-128", "#EXTINF:5,", "seg.ts", "#EXT-X-ENDLIST"], "URI"],
  ["unsupported key method", ["#EXTM3U", "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key.bin\"", "#EXTINF:5,", "seg.ts", "#EXT-X-ENDLIST"], "加密"],
  ["non-identity key format", ["#EXTM3U", "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",KEYFORMAT=\"com.example\"", "#EXTINF:5,", "seg.ts", "#EXT-X-ENDLIST"], "KEYFORMAT"],
  ["malformed AES IV", ["#EXTM3U", "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1234", "#EXTINF:5,", "seg.ts", "#EXT-X-ENDLIST"], "IV"],
  ["encrypted map without explicit IV", ["#EXTM3U", "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"", "#EXT-X-MAP:URI=\"init.mp4\"", "#EXTINF:5,", "seg.m4s", "#EXT-X-ENDLIST"], "EXT-X-MAP"],
  ["non-HTTP segment URI", ["#EXTM3U", "#EXTINF:5,", "data:text/plain,video", "#EXT-X-ENDLIST"], "HTTP"],
  ["live playlists", ["#EXTM3U", "#EXTINF:5,", "seg.ts"], "直播"],
]) {
  test("rejects unsupported " + name, () => {
    assert.throws(
      () => parseHlsPlaylist(playlist(lines), "https://cdn.example.com/index.m3u8"),
      new RegExp(expectedMessage),
    );
  });
}
