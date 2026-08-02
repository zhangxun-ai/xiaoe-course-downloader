const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createTabResolver,
} = require("../shared/tab-resolver.js");

function resolverHarness(overrides = {}, resolverOptions = {}) {
  let currentTime = 1_000;
  let nextTabId = 40;
  const calls = [];
  const adapter = {
    async createTab(options) {
      const tab = { id: nextTabId };
      nextTabId += 1;
      calls.push(["createTab", options]);
      return tab;
    },
    async clearCandidates(tabId, navigationStartedAt) {
      calls.push(["clearCandidates", tabId, navigationStartedAt]);
      return { navigationStartedAt };
    },
    async waitForComplete(tabId, options) {
      calls.push(["waitForComplete", tabId, options]);
    },
    async scanPage(tabId) {
      calls.push(["scanPage", tabId]);
      return { navigationStartedAt: currentTime, candidates: [] };
    },
    async getCandidates(tabId, navigationStartedAt) {
      calls.push(["getCandidates", tabId, navigationStartedAt]);
      return { navigationStartedAt, candidates: [] };
    },
    async closeTab(tabId) {
      calls.push(["closeTab", tabId]);
    },
    ...overrides,
  };
  const resolver = createTabResolver(adapter, {
    now: () => currentTime,
    sleep: async (milliseconds) => { currentTime += milliseconds; },
    pollIntervalMs: 250,
    ...resolverOptions,
  });
  return {
    adapter,
    calls,
    resolver,
    now: () => currentTime,
    advance: (milliseconds) => { currentTime += milliseconds; },
  };
}

test("creates an inactive lesson tab and scopes clear/read calls to its navigation epoch", async () => {
  const { calls, resolver } = resolverHarness({
    async getCandidates(tabId, navigationStartedAt) {
      calls.push(["getCandidates", tabId, navigationStartedAt]);
      return {
        navigationStartedAt,
        candidates: [{
          url: "https://cdn.example.test/lesson.mp3",
          mime: "audio/mpeg",
          source: "network",
          capturedAt: navigationStartedAt + 1,
          navigationStartedAt,
        }],
      };
    },
  });

  const result = await resolver.resolve("https://school.example.test/lesson/1");

  assert.equal(result.url, "https://cdn.example.test/lesson.mp3");
  assert.deepEqual(calls[0], ["createTab", {
    url: "https://school.example.test/lesson/1",
    active: false,
  }]);
  assert.deepEqual(calls.find((entry) => entry[0] === "clearCandidates"), [
    "clearCandidates", 40, 1_000,
  ]);
  assert.deepEqual(calls.find((entry) => entry[0] === "getCandidates").slice(0, 3), [
    "getCandidates", 40, 1_000,
  ]);
});

test("converts Xiaoetong content_page audio links into directly loadable PC lesson URLs", async () => {
  const { calls, resolver } = resolverHarness({
    async scanPage() {
      return {
        navigationStartedAt: 1_000,
        candidates: [{
          url: "https://cdn.example.test/lesson-63.mp3",
          mime: "audio/mpeg",
          source: "dom",
        }],
      };
    },
  });
  const payload = Buffer.from(JSON.stringify({
    app_id: "apppf3vpmq16406",
    product_id: "p_64eee070e4b064a8373ec3a2",
    resource_id: "a_65e3ff9be4b04c1044c8f36a",
    resource_type: 2,
    type: 2,
  })).toString("base64url");

  await resolver.resolve(`https://apppf3vpmq16406.xet-pc.citv.cn/content_page/${payload}`);

  assert.deepEqual(calls[0], ["createTab", {
    url: "https://apppf3vpmq16406.xet-pc.citv.cn/p/t_pc/course_pc_detail/audio/a_65e3ff9be4b04c1044c8f36a?product_id=p_64eee070e4b064a8373ec3a2",
    active: false,
  }]);
});

test("accepts current-page DOM media despite small cross-clock navigation drift", async () => {
  const pageUrl = "https://school.example.test/lesson/current";
  const { resolver } = resolverHarness({
    async clearCandidates() {
      return { navigationStartedAt: 1_004 };
    },
    async scanPage() {
      return {
        pageUrl,
        navigationStartedAt: 1_000,
        candidates: [{
          url: "https://cdn.example.test/current.mp3",
          mime: "audio/mpeg",
          source: "dom",
        }],
      };
    },
    async getCandidates(_tabId, navigationStartedAt) {
      return { navigationStartedAt, candidates: [] };
    },
  });

  const result = await resolver.resolve(pageUrl);

  assert.equal(result.url, "https://cdn.example.test/current.mp3");
});

test("prefers a direct DOM audio source over a network playlist", async () => {
  const { resolver } = resolverHarness({
    async scanPage() {
      return {
        title: "Lesson",
        navigationStartedAt: 1_000,
        candidates: [{
          url: "https://cdn.example.test/direct.mp3?token=fresh",
          mime: "audio/mpeg",
          source: "dom",
        }],
      };
    },
    async getCandidates(_tabId, navigationStartedAt) {
      return {
        navigationStartedAt,
        candidates: [{
          url: "https://cdn.example.test/master.m3u8?token=fresh",
          mime: "application/vnd.apple.mpegurl",
          source: "network",
          capturedAt: navigationStartedAt + 2,
          navigationStartedAt,
        }],
      };
    },
  });

  const result = await resolver.resolve("https://school.example.test/lesson/2");

  assert.equal(result.url, "https://cdn.example.test/direct.mp3?token=fresh");
  assert.equal(result.source, "dom");
  assert.equal(result.kind, "direct");
});

test("does not choose between multiple direct DOM URLs at the same trust level", async () => {
  const { resolver } = resolverHarness({
    async scanPage() {
      return {
        navigationStartedAt: 1_000,
        candidates: [
          { url: "https://cdn.example.test/one.mp3", mime: "audio/mpeg", source: "dom" },
          { url: "https://cdn.example.test/two.mp3", mime: "audio/mpeg", source: "dom" },
        ],
      };
    },
  });

  await assert.rejects(
    () => resolver.resolve("https://school.example.test/lesson/ambiguous-dom"),
    /候选.*不唯一|歧义/i,
  );
});

test("selects the newest network URL within one confidence level", async () => {
  const { resolver } = resolverHarness({
    async getCandidates(_tabId, navigationStartedAt) {
      return {
        navigationStartedAt,
        candidates: [
          {
            url: "https://cdn.example.test/older.mp3",
            mime: "audio/mpeg",
            source: "network",
            capturedAt: navigationStartedAt + 1,
            navigationStartedAt,
          },
          {
            url: "https://cdn.example.test/newest.mp3",
            mime: "audio/mpeg",
            source: "network",
            capturedAt: navigationStartedAt + 2,
            navigationStartedAt,
          },
        ],
      };
    },
  });

  const result = await resolver.resolve("https://school.example.test/lesson/network-newest");
  assert.equal(result.url, "https://cdn.example.test/newest.mp3");
});

test("does not choose between equally fresh network URLs at one confidence level", async () => {
  const { resolver } = resolverHarness({
    async getCandidates(_tabId, navigationStartedAt) {
      return {
        navigationStartedAt,
        candidates: [
          {
            url: "https://cdn.example.test/a.mp3",
            mime: "audio/mpeg",
            source: "network",
            capturedAt: navigationStartedAt + 1,
            navigationStartedAt,
          },
          {
            url: "https://cdn.example.test/b.mp3",
            mime: "audio/mpeg",
            source: "network",
            capturedAt: navigationStartedAt + 1,
            navigationStartedAt,
          },
        ],
      };
    },
  });

  await assert.rejects(
    () => resolver.resolve("https://school.example.test/lesson/ambiguous-network"),
    /候选.*不唯一|歧义/i,
  );
});

test("rejects candidates from a stale navigation and accepts only the current epoch", async () => {
  let reads = 0;
  const { resolver } = resolverHarness({
    async clearCandidates() {
      return { navigationStartedAt: 1_100 };
    },
    async getCandidates(_tabId, navigationStartedAt) {
      reads += 1;
      if (reads === 1) {
        return {
          navigationStartedAt: 1_050,
          candidates: [{
            url: "https://cdn.example.test/stale.mp3",
            mime: "audio/mpeg",
            source: "network",
            capturedAt: 1_099,
            navigationStartedAt: 1_050,
          }],
        };
      }
      return {
        navigationStartedAt,
        candidates: [{
          url: "https://cdn.example.test/current.mp3",
          mime: "audio/mpeg",
          source: "network",
          capturedAt: navigationStartedAt + 1,
          navigationStartedAt,
        }],
      };
    },
  });

  const result = await resolver.resolve("https://school.example.test/lesson/3");

  assert.equal(reads, 2);
  assert.equal(result.url, "https://cdn.example.test/current.mp3");
  assert.equal(result.navigationStartedAt, 1_100);
});

test("rescans the DOM when the background reports a newer navigation epoch", async () => {
  let scans = 0;
  let reads = 0;
  const { resolver } = resolverHarness({
    async scanPage() {
      scans += 1;
      return {
        navigationStartedAt: scans === 1 ? 1_000 : 1_100,
        candidates: [{
          url: `https://cdn.example.test/${scans === 1 ? "old" : "new"}.mp3`,
          mime: "audio/mpeg",
          source: "dom",
        }],
      };
    },
    async getCandidates(_tabId, requestedEpoch) {
      reads += 1;
      return {
        navigationStartedAt: reads === 1 ? requestedEpoch + 100 : requestedEpoch,
        candidates: [],
      };
    },
  });

  const result = await resolver.resolve("https://school.example.test/lesson/redirect");

  assert.equal(scans, 2);
  assert.equal(result.url, "https://cdn.example.test/new.mp3");
  assert.equal(result.navigationStartedAt, 1_100);
});

test("rejects a DOM candidate whose page timeOrigin predates the current epoch", async () => {
  const { resolver } = resolverHarness({
    async clearCandidates() {
      return { navigationStartedAt: 1_100 };
    },
    async scanPage() {
      return {
        pageUrl: "https://school.example.test/lesson/old-document",
        navigationStartedAt: 1_050,
        candidates: [{
          url: "https://cdn.example.test/stale-dom.mp3",
          mime: "audio/mpeg",
          source: "dom",
        }],
      };
    },
    async getCandidates(_tabId, navigationStartedAt) {
      return {
        navigationStartedAt,
        candidates: [{
          url: "https://cdn.example.test/current-network.mp3",
          mime: "audio/mpeg",
          source: "network",
          capturedAt: navigationStartedAt + 1,
          navigationStartedAt,
        }],
      };
    },
  });

  const result = await resolver.resolve("https://school.example.test/lesson/current");
  assert.equal(result.url, "https://cdn.example.test/current-network.mp3");
});

test("uses one 15-second deadline for completion and candidate polling", async () => {
  const { calls, resolver, now } = resolverHarness();

  await assert.rejects(
    () => resolver.resolve("https://school.example.test/lesson/timeout"),
    /15.*秒|超时/i,
  );

  assert.equal(now(), 16_000);
  assert.equal(calls.filter((entry) => entry[0] === "createTab").length, 1);
  assert.deepEqual(calls.at(-1), ["closeTab", 40]);
});

for (const phase of [
  "createTab",
  "clearCandidates",
  "waitForComplete",
  "scanPage",
  "getCandidates",
]) {
  test(`${phase} cannot succeed after the shared absolute deadline`, async () => {
    const harness = resolverHarness();
    const original = harness.adapter[phase];
    harness.adapter[phase] = async (...args) => {
      harness.advance(15_000);
      return original(...args);
    };

    await assert.rejects(
      () => harness.resolver.resolve("https://school.example.test/lesson/late"),
      /15.*秒|超时/i,
    );
  });
}

test("a hanging adapter phase is rejected by the hard deadline", async () => {
  const { resolver } = resolverHarness({
    async createTab() {
      return new Promise(() => {});
    },
  }, { timeoutMs: 20 });

  await assert.rejects(
    () => resolver.resolve("https://school.example.test/lesson/hanging"),
    /超时/i,
  );
});

test("always closes the created tab when scanning fails", async () => {
  const { calls, resolver } = resolverHarness({
    async scanPage() {
      throw new Error("scanner unavailable");
    },
  });

  await assert.rejects(
    () => resolver.resolve("https://school.example.test/lesson/failure"),
    /scanner unavailable/,
  );
  assert.deepEqual(calls.at(-1), ["closeTab", 40]);
});

test("a closeTab rejection does not replace a successful resolution", async () => {
  const { resolver } = resolverHarness({
    async scanPage() {
      return {
        navigationStartedAt: 1_000,
        candidates: [{
          url: "https://cdn.example.test/success.mp3",
          mime: "audio/mpeg",
          source: "dom",
        }],
      };
    },
    async closeTab() {
      throw new Error("No tab with id: 40");
    },
  });

  const result = await resolver.resolve("https://school.example.test/lesson/success");
  assert.equal(result.url, "https://cdn.example.test/success.mp3");
});

test("a closeTab rejection does not replace the primary resolver error", async () => {
  const { resolver } = resolverHarness({
    async scanPage() {
      throw new Error("primary scanner failure");
    },
    async closeTab() {
      throw new Error("No tab with id: 40");
    },
  });

  await assert.rejects(
    () => resolver.resolve("https://school.example.test/lesson/failure-close"),
    /primary scanner failure/,
  );
});

test("a hanging closeTab is bounded by an independent cleanup budget", async () => {
  const { resolver } = resolverHarness({
    async scanPage() {
      return {
        navigationStartedAt: 1_000,
        candidates: [{
          url: "https://cdn.example.test/cleanup-budget.mp3",
          mime: "audio/mpeg",
          source: "dom",
        }],
      };
    },
    async closeTab() {
      return new Promise(() => {});
    },
  }, { closeTimeoutMs: 20 });

  const result = await resolver.resolve("https://school.example.test/lesson/cleanup-budget");
  assert.equal(result.url, "https://cdn.example.test/cleanup-budget.mp3");
});

test("each resolver invocation creates and closes a fresh inactive tab", async () => {
  const { calls, resolver } = resolverHarness({
    async scanPage(tabId) {
      return {
        navigationStartedAt: 1_000,
        candidates: [{
          url: `https://cdn.example.test/${tabId}.mp3?signature=ephemeral`,
          mime: "audio/mpeg",
          source: "dom",
        }],
      };
    },
  });

  const first = await resolver.resolve("https://school.example.test/lesson/retry");
  const second = await resolver.resolve("https://school.example.test/lesson/retry");

  assert.notEqual(first.url, second.url);
  assert.deepEqual(
    calls.filter((entry) => entry[0] === "createTab").map((entry) => entry[1].active),
    [false, false],
  );
  assert.deepEqual(
    calls.filter((entry) => entry[0] === "closeTab").map((entry) => entry[1]),
    [40, 41],
  );
});

test("background and scanner keep epoch and immediate-audio contracts", () => {
  const root = path.resolve(__dirname, "..");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const scanner = fs.readFileSync(
    path.join(root, "content-scripts/page-scanner.js"),
    "utf8",
  );

  assert.match(background, /navigationStartedAt/);
  assert.match(background, /details\.timeStamp/);
  assert.doesNotMatch(background, /video\/unknown/);
  assert.doesNotMatch(scanner, /\.play\s*\(/);
  assert.match(scanner, /directAudio/);
  assert.match(scanner, /navigationStartedAt:\s*performance\.timeOrigin/);
  assert.match(scanner, /pageUrl:\s*location\.href/);
});
