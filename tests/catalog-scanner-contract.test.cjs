const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scannerPath = path.resolve(
  __dirname,
  "../content-scripts/catalog-scanner.js",
);

test("scanner names the observed Vue catalog contract without credential stores", () => {
  const source = fs.readFileSync(scannerPath, "utf8");

  for (const required of [
    ".column_catalog",
    "__vue__",
    "loadMoreCourse",
    "total",
    "columnList",
    "XiaoeCatalogLoader",
  ]) {
    assert.match(source, new RegExp(required.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(source, /document\.cookie|localStorage/i);
});

test("scanner delegates loading and returns only the allowed snapshot fields", async () => {
  let delegated = false;
  let componentLoadCalled = false;
  const component = {
    total: 1,
    pageSize: 20,
    pageIndex: 1,
    productId: "product-safe",
    secretComponentField: "must-not-leak",
    columnList: [
      {
        resource_id: "lesson-safe",
        resource_title: "65. 体制内的思考",
        resource_type: 2,
        jump_url: "/lesson-safe",
        can_view: 0,
        is_try: 1,
        secretItemField: "must-not-leak",
      },
    ],
    loadMoreCourse() {
      componentLoadCalled = true;
    },
  };
  const context = {
    document: {
      querySelector(selector) {
        assert.equal(selector, ".column_catalog");
        return { __vue__: component };
      },
    },
    setTimeout,
    XiaoeCatalogLoader: {
      async loadCompleteCatalog(adapter, options) {
        delegated = true;
        assert.equal(options.perPageTimeoutMs, 15_000);
        assert.equal(adapter.getTotal(), 1);
        adapter.loadMore();
        return adapter.getItems();
      },
    },
  };

  const source = fs.readFileSync(scannerPath, "utf8");
  const snapshot = JSON.parse(
    JSON.stringify(await vm.runInNewContext(source, context)),
  );

  assert.equal(delegated, true);
  assert.equal(componentLoadCalled, true);
  assert.deepEqual(snapshot, {
    total: 1,
    pageSize: 20,
    pageIndex: 1,
    productId: "product-safe",
    columnList: [
      {
        resource_id: "lesson-safe",
        resource_title: "65. 体制内的思考",
        resource_type: 2,
        jump_url: "/lesson-safe",
        can_view: 0,
        is_try: 1,
      },
    ],
  });
});
