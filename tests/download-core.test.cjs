const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchMedia,
  loadHlsPlan,
  writeDirectMedia,
  writeHlsResources,
} = require("../shared/download-core.js");

function fakeWritable() {
  return {
    chunks: [],
    closed: false,
    aborted: false,
    async write(chunk) {
      this.chunks.push(Buffer.from(chunk));
    },
    async close() {
      this.closed = true;
    },
    async abort() {
      this.aborted = true;
    },
  };
}

test("fetches media with the signed-in browser credentials", async () => {
  let receivedOptions;
  const response = await fetchMedia(async (_url, options) => {
    receivedOptions = options;
    return new Response("ok");
  }, "https://cdn.example.com/media.mp4");

  assert.equal(response.ok, true);
  assert.equal(receivedOptions.credentials, "include");
  assert.equal(receivedOptions.cache, "no-store");
});

test("explains a 403 as an authentication or referrer limitation", async () => {
  await assert.rejects(
    () => fetchMedia(async () => new Response("", { status: 403 }), "https://cdn.example.com/media"),
    /登录凭据|Referer/,
  );
});

test("streams one direct response into the writable and closes it", async () => {
  const writable = fakeWritable();
  const progress = [];
  const result = await writeDirectMedia(
    "https://cdn.example.com/media.mp4",
    async () => new Response(new Uint8Array([1, 2, 3, 4])),
    writable,
    (state) => progress.push(state),
  );

  assert.equal(result.bytesWritten, 4);
  assert.equal(writable.closed, true);
  assert.equal(writable.aborted, false);
  assert.deepEqual(Buffer.concat(writable.chunks), Buffer.from([1, 2, 3, 4]));
  assert.equal(progress.at(-1).bytesWritten, 4);
});

test("direct download can leave the writable open for a batch commit owner", async () => {
  const writable = fakeWritable();
  const result = await writeDirectMedia(
    "https://cdn.example.com/media.mp4",
    async () => new Response(new Uint8Array([1, 2, 3, 4])),
    writable,
    undefined,
    { close: false },
  );

  assert.deepEqual(result, { bytesWritten: 4 });
  assert.equal(writable.closed, false);
  assert.equal(writable.aborted, false);
});

test("aborts a zero-byte direct download", async () => {
  const writable = fakeWritable();
  await assert.rejects(
    () => writeDirectMedia("https://cdn.example.com/empty.mp4", async () => new Response(null), writable),
    /零字节/,
  );
  assert.equal(writable.aborted, true);
  assert.equal(writable.closed, false);
});

test("rejects an HTML page returned from a supposed direct-media URL", async () => {
  const writable = fakeWritable();

  await assert.rejects(
    () => writeDirectMedia(
      "https://school.example.test/course/lesson",
      async () => new Response("<!DOCTYPE html><title>Course</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      writable,
    ),
    /非媒体|HTML/i,
  );

  assert.equal(writable.aborted, true);
  assert.equal(writable.closed, false);
  assert.equal(writable.chunks.length, 0);
});

test("follows a master playlist to a final VOD media plan", async () => {
  const requested = [];
  const responses = new Map([
    [
      "https://cdn.example.com/master.m3u8",
      `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia/high.m3u8`,
    ],
    [
      "https://cdn.example.com/media/high.m3u8",
      `#EXTM3U\n#EXTINF:5,\nseg-1.ts\n#EXT-X-ENDLIST`,
    ],
  ]);
  const plan = await loadHlsPlan(
    "https://cdn.example.com/master.m3u8",
    async (url) => {
      requested.push(url);
      return new Response(responses.get(url));
    },
  );

  assert.deepEqual(requested, [
    "https://cdn.example.com/master.m3u8",
    "https://cdn.example.com/media/high.m3u8",
  ]);
  assert.deepEqual(plan, {
    extension: "ts",
    resources: [{ url: "https://cdn.example.com/media/seg-1.ts", kind: "media" }],
  });
});

test("writes HLS resources sequentially and closes after positive bytes", async () => {
  const writable = fakeWritable();
  const requested = [];
  const result = await writeHlsResources(
    ["https://cdn.example.com/1.ts", "https://cdn.example.com/2.ts"],
    async (url) => {
      requested.push(url);
      return new Response(url.endsWith("1.ts") ? "one" : "two");
    },
    writable,
  );

  assert.deepEqual(requested, [
    "https://cdn.example.com/1.ts",
    "https://cdn.example.com/2.ts",
  ]);
  assert.equal(result.bytesWritten, 6);
  assert.equal(writable.closed, true);
  assert.deepEqual(Buffer.concat(writable.chunks).toString(), "onetwo");
});

test("HLS download can leave the writable open for a batch commit owner", async () => {
  const writable = fakeWritable();
  const result = await writeHlsResources(
    ["https://cdn.example.com/1.ts", "https://cdn.example.com/2.ts"],
    async (url) => new Response(url.endsWith("1.ts") ? "one" : "two"),
    writable,
    undefined,
    { close: false },
  );

  assert.deepEqual(result, { bytesWritten: 6 });
  assert.equal(writable.closed, false);
  assert.equal(writable.aborted, false);
});

test("decrypts AES-128 HLS segments before writing and caches the key per task", async () => {
  const writable = fakeWritable();
  const key = new Uint8Array(16);
  const iv = new Uint8Array(16);
  const plaintext = new TextEncoder().encode("video segment");
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]),
    plaintext,
  );
  let keyRequests = 0;
  const result = await writeHlsResources(
    [
      { url: "https://cdn.example.com/1.ts", kind: "media", keyUrl: "https://cdn.example.com/key.bin", iv },
      { url: "https://cdn.example.com/2.ts", kind: "media", keyUrl: "https://cdn.example.com/key.bin", iv },
    ],
    async (url) => {
      if (url.endsWith("key.bin")) {
        keyRequests += 1;
        return new Response(key);
      }
      return new Response(encrypted.slice(0));
    },
    writable,
    undefined,
    { cryptoImpl: crypto },
  );

  assert.equal(keyRequests, 1);
  assert.equal(result.bytesWritten, plaintext.byteLength * 2);
  assert.deepEqual(Buffer.concat(writable.chunks), Buffer.concat([Buffer.from(plaintext), Buffer.from(plaintext)]));
});

test("aborts AES HLS writes before output for an invalid key or ciphertext", async () => {
  const writable = fakeWritable();
  await assert.rejects(
    () => writeHlsResources(
      [{ url: "https://cdn.example.com/1.ts", kind: "media", keyUrl: "https://cdn.example.com/key.bin", iv: new Uint8Array(16) }],
      async (url) => new Response(url.endsWith("key.bin") ? new Uint8Array(15) : new Uint8Array(15)),
      writable,
      undefined,
      { cryptoImpl: crypto },
    ),
    /16 字节|16 的倍数/,
  );
  assert.equal(writable.aborted, true);
  assert.equal(writable.closed, false);
  assert.equal(writable.chunks.length, 0);
});

test("rejects HTML HLS segments before writing", async () => {
  const writable = fakeWritable();
  await assert.rejects(
    () => writeHlsResources(
      [{ url: "https://cdn.example.com/1.ts", kind: "media" }],
      async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
      writable,
    ),
    /非媒体|HTML/i,
  );
  assert.equal(writable.aborted, true);
});

test("prefetches five HLS resources but writes them in playlist order", async () => {
  const writable = fakeWritable();
  const starts = [];
  const waiting = new Map();
  const resources = ["1.ts", "2.ts", "3.ts", "4.ts", "5.ts", "6.ts"].map((name) => ({
    url: "https://cdn.example.com/" + name,
    kind: "media",
  }));
  const run = writeHlsResources(
    resources,
    (url) => new Promise((resolve) => {
      starts.push(url);
      waiting.set(url, resolve);
    }),
    writable,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, resources.slice(0, 5).map((resource) => resource.url));
  for (const resource of resources) {
    while (!waiting.has(resource.url)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    waiting.get(resource.url)(new Response(resource.url.slice(-4)));
  }
  await run;
  assert.equal(Buffer.concat(writable.chunks).toString(), "1.ts2.ts3.ts4.ts5.ts6.ts");
});
