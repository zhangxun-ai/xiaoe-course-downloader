const test = require("node:test");
const assert = require("node:assert/strict");

const { loadCompleteCatalog } = require("../shared/catalog-loader.js");

function makeItems(count, start = 1) {
  return Array.from({ length: count }, (_, offset) => ({
    resource_id: `lesson-${start + offset}`,
  }));
}

test("loads a real asynchronous 20 to 40 to 60 to 80 to 88 catalog", async () => {
  let items = makeItems(20);
  let showLoading = false;
  const requestedAt = [];
  const pageLengths = [40, 60, 80, 88];
  const adapter = {
    getTotal: () => 88,
    getItems: () => items,
    isLoading: () => showLoading,
    async loadMore() {
      requestedAt.push(items.length);
      showLoading = true;
      await Promise.resolve();
      items = makeItems(pageLengths.shift());
      showLoading = false;
    },
  };

  const result = await loadCompleteCatalog(adapter, {
    sleep: () => Promise.resolve(),
  });

  assert.deepEqual(requestedAt, [20, 40, 60, 80]);
  assert.equal(result.length, 88);
  assert.equal(result.at(-1).resource_id, "lesson-88");
});

test("observes showLoading until the requested page grows", async () => {
  let items = makeItems(1);
  let showLoading = false;
  let polls = 0;
  const adapter = {
    getTotal: () => 2,
    getItems: () => items,
    isLoading: () => showLoading,
    loadMore() {
      showLoading = true;
    },
  };

  const result = await loadCompleteCatalog(adapter, {
    pollIntervalMs: 25,
    sleep: async (milliseconds) => {
      assert.equal(milliseconds, 25);
      polls += 1;
      if (polls === 2) {
        items = makeItems(2);
        showLoading = false;
      }
    },
  });

  assert.equal(polls, 2);
  assert.equal(result.length, 2);
});

test("waits for loadMore settlement and showLoading false after early growth", async () => {
  let items = makeItems(1);
  let showLoading = false;
  let requests = 0;
  let polls = 0;
  let settleFirstPage;
  const adapter = {
    getTotal: () => 3,
    getItems: () => items,
    isLoading: () => showLoading,
    loadMore() {
      requests += 1;
      if (requests === 1) {
        items = makeItems(2);
        showLoading = true;
        return new Promise((resolve) => {
          settleFirstPage = resolve;
        });
      }
      items = makeItems(3);
      return Promise.resolve();
    },
  };

  const result = await loadCompleteCatalog(adapter, {
    sleep: async () => {
      polls += 1;
      if (polls === 1) {
        assert.equal(requests, 1);
        showLoading = false;
        settleFirstPage();
      }
    },
  });

  assert.equal(polls >= 1, true);
  assert.equal(requests, 2);
  assert.equal(result.length, 3);
});

test("propagates a loadMore rejection that happens after the list grows", async () => {
  let items = makeItems(1);
  let showLoading = false;

  await assert.rejects(
    () =>
      loadCompleteCatalog(
        {
          getTotal: () => 2,
          getItems: () => items,
          isLoading: () => showLoading,
          async loadMore() {
            showLoading = true;
            items = makeItems(2);
            await Promise.resolve();
            showLoading = false;
            throw new Error("late page failure");
          },
        },
        { sleep: () => Promise.resolve() },
      ),
    /late page failure/i,
  );
});

test("rejects a page containing duplicate resource ids", async () => {
  let items = makeItems(2);
  await assert.rejects(
    () =>
      loadCompleteCatalog(
        {
          getTotal: () => 3,
          getItems: () => items,
          isLoading: () => false,
          async loadMore() {
            items = [...items, { resource_id: "lesson-2" }];
          },
        },
        { sleep: () => Promise.resolve() },
      ),
    /duplicate resource id/i,
  );
});

test("rejects a settled page request with no growth", async () => {
  await assert.rejects(
    () =>
      loadCompleteCatalog(
        {
          getTotal: () => 2,
          getItems: () => makeItems(1),
          isLoading: () => false,
          loadMore() {},
        },
        { sleep: () => Promise.resolve() },
      ),
    /no growth/i,
  );
});

test("rejects count overflow immediately", async () => {
  let items = makeItems(2);
  await assert.rejects(
    () =>
      loadCompleteCatalog(
        {
          getTotal: () => 3,
          getItems: () => items,
          isLoading: () => false,
          async loadMore() {
            items = makeItems(4);
          },
        },
        { sleep: () => Promise.resolve() },
      ),
    /overflow/i,
  );
});

test("rejects an adapter-declared end below the exact total as underflow", async () => {
  await assert.rejects(
    () =>
      loadCompleteCatalog(
        {
          getTotal: () => 3,
          getItems: () => makeItems(2),
          isLoading: () => false,
          loadMore: () => false,
        },
        { sleep: () => Promise.resolve() },
      ),
    /underflow/i,
  );
});

test("starts a fresh fifteen-second timeout budget for every requested page", async () => {
  let items = makeItems(1);
  let showLoading = false;
  let nowValue = 0;
  let pagePolls = 0;
  let requests = 0;
  const adapter = {
    getTotal: () => 3,
    getItems: () => items,
    isLoading: () => showLoading,
    loadMore() {
      requests += 1;
      pagePolls = 0;
      showLoading = true;
    },
  };

  const result = await loadCompleteCatalog(adapter, {
    perPageTimeoutMs: 15_000,
    pollIntervalMs: 100,
    now: () => nowValue,
    sleep: async () => {
      nowValue += 7_000;
      pagePolls += 1;
      if (pagePolls === 2) {
        items = makeItems(items.length + 1);
        showLoading = false;
      }
    },
  });

  assert.equal(requests, 2);
  assert.equal(nowValue, 28_000);
  assert.equal(result.length, 3);
});

test("times out one page that exceeds its own budget", async () => {
  let nowValue = 0;
  await assert.rejects(
    () =>
      loadCompleteCatalog(
        {
          getTotal: () => 2,
          getItems: () => makeItems(1),
          isLoading: () => true,
          loadMore() {},
        },
        {
          perPageTimeoutMs: 15_000,
          now: () => nowValue,
          sleep: async () => {
            nowValue += 8_000;
          },
        },
      ),
    /timed out.*15000/i,
  );
});
