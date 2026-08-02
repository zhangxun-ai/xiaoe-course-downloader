(async () => {
  "use strict";

  const timeoutMs = 15_000;
  const pollIntervalMs = 50;

  async function findCatalogComponent() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const component = document.querySelector(".column_catalog")?.__vue__;
      if (
        component &&
        Number.isInteger(component.total) &&
        Array.isArray(component.columnList) &&
        typeof component.loadMoreCourse === "function"
      ) {
        return component;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error("未在限时内找到小鹅通专栏目录组件");
  }

  function safeScalar(value) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    return value === undefined ? null : String(value);
  }

  function sanitizeItem(item) {
    return {
      resource_id: String(item?.resource_id ?? ""),
      resource_title: String(item?.resource_title ?? ""),
      resource_type: safeScalar(item?.resource_type),
      jump_url: String(item?.jump_url ?? ""),
      can_view: safeScalar(item?.can_view),
      is_try: safeScalar(item?.is_try),
    };
  }

  const component = await findCatalogComponent();
  const adapter = {
    getTotal: () => component.total,
    getItems: () => component.columnList,
    isLoading: () => Boolean(component.showLoading),
    loadMore: () => component.loadMoreCourse(),
  };
  const items = await globalThis.XiaoeCatalogLoader.loadCompleteCatalog(adapter, {
    perPageTimeoutMs: timeoutMs,
    pollIntervalMs,
  });

  return {
    total: safeScalar(component.total),
    pageSize: safeScalar(component.pageSize),
    pageIndex: safeScalar(component.pageIndex),
    productId: String(component.productId ?? component.product_id ?? ""),
    columnList: items.map(sanitizeItem),
  };
})();
