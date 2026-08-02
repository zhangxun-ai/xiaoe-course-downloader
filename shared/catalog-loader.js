(function attachCatalogLoader(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.XiaoeCatalogLoader = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createCatalogLoader() {
  "use strict";

  function defaultSleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function readItems(adapter, total) {
    const items = adapter.getItems();
    if (!Array.isArray(items)) {
      throw new Error("Catalog adapter did not return an item list");
    }
    if (items.length > total) {
      throw new Error(
        `Catalog count overflow: received ${items.length}, declared ${total}`,
      );
    }

    const ids = new Set();
    for (const item of items) {
      const id = String(item?.resource_id || "").trim();
      if (!id) throw new Error("Catalog item is missing resource id");
      if (ids.has(id)) throw new Error(`Duplicate resource id: ${id}`);
      ids.add(id);
    }
    return items;
  }

  async function loadCompleteCatalog(adapter, options = {}) {
    if (
      !adapter ||
      typeof adapter.getTotal !== "function" ||
      typeof adapter.getItems !== "function" ||
      typeof adapter.loadMore !== "function"
    ) {
      throw new Error("Catalog loader requires getTotal, getItems, and loadMore");
    }

    const perPageTimeoutMs = options.perPageTimeoutMs ?? 15_000;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    if (!Number.isFinite(perPageTimeoutMs) || perPageTimeoutMs <= 0) {
      throw new Error("Catalog per-page timeout must be positive");
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      throw new Error("Catalog poll interval must not be negative");
    }

    const total = adapter.getTotal();
    if (!Number.isInteger(total) || total <= 0) {
      throw new Error("Catalog declared total must be a positive integer");
    }

    let items = readItems(adapter, total);
    while (items.length < total) {
      const previousLength = items.length;
      const pageStartedAt = now();
      let requestSettled = false;
      let requestResult;
      let requestError;
      let waited = false;

      Promise.resolve()
        .then(() => adapter.loadMore())
        .then(
          (result) => {
            requestResult = result;
            requestSettled = true;
          },
          (error) => {
            requestError = error;
            requestSettled = true;
          },
        );

      // Let synchronous and immediately-resolved adapters enter their loading state.
      await Promise.resolve();

      while (true) {
        items = readItems(adapter, total);
        if (requestError) throw requestError;
        const grew = items.length > previousLength;
        const showLoading =
          typeof adapter.isLoading === "function" && adapter.isLoading();
        if (grew && requestSettled && !showLoading) break;
        if (!grew && requestSettled && requestResult === false) {
          throw new Error(
            `Catalog count underflow: received ${items.length}, declared ${total}`,
          );
        }
        if (now() - pageStartedAt >= perPageTimeoutMs) {
          throw new Error(
            `Catalog page timed out after ${perPageTimeoutMs}ms`,
          );
        }

        if (!grew && requestSettled && !showLoading && waited) {
          throw new Error(
            `Catalog page produced no growth (${items.length} of ${total})`,
          );
        }
        await sleep(pollIntervalMs);
        waited = true;
      }
    }

    items = readItems(adapter, total);
    if (items.length !== total) {
      throw new Error(
        `Catalog count underflow: received ${items.length}, declared ${total}`,
      );
    }
    return items.slice();
  }

  return { loadCompleteCatalog };
});
