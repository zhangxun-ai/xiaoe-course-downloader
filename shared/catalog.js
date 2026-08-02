(function attachCatalog(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.XiaoeCatalog = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createCatalog() {
  "use strict";

  function extractProductId(snapshot, pageUrl) {
    const snapshotId = String(
      snapshot?.product_id ?? snapshot?.productId ?? "",
    ).trim();
    if (snapshotId) return snapshotId;

    try {
      return new URL(pageUrl).searchParams.get("product_id")?.trim() || "";
    } catch {
      return "";
    }
  }

  function parseLessonNumber(title) {
    const match = String(title || "").trim().match(/^(\d+)\s*[.\u3001\uff0e-]/);
    return match ? Number(match[1]) : null;
  }

  function validateDeclaredTotal(total) {
    if (!Number.isInteger(total) || total <= 0) {
      throw new Error("Catalog declared total must be a positive integer");
    }
  }

  function validateLessonUrl(pageUrl) {
    let parsed;
    try {
      parsed = new URL(pageUrl);
    } catch {
      throw new Error("Catalog lesson has a missing or invalid link");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Catalog lesson has a missing or invalid link");
    }
  }

  function validateLessonNumberOrder(lessons) {
    const seen = new Set();
    let previous = null;
    let direction = 0;

    for (const lesson of lessons) {
      const lessonNumber = lesson?.lessonNumber;
      if (lessonNumber === null || lessonNumber === undefined) continue;
      if (seen.has(lessonNumber)) {
        throw new Error(`Duplicate lesson number: ${lessonNumber}`);
      }
      seen.add(lessonNumber);

      if (previous !== null) {
        const nextDirection = Math.sign(lessonNumber - previous);
        if (direction === 0) {
          direction = nextDirection;
        } else if (nextDirection !== direction) {
          throw new Error("Catalog lesson number direction is not monotonic");
        }
      }
      previous = lessonNumber;
    }
  }

  function validateCompleteCatalog(lessons, total) {
    validateDeclaredTotal(total);
    if (!Array.isArray(lessons) || lessons.length !== total) {
      throw new Error(`Catalog must contain exactly its declared total of ${total} lessons`);
    }

    const ids = new Set();
    for (const lesson of lessons) {
      const lessonId = String(lesson?.lessonId || "").trim();
      if (!lessonId) throw new Error("Catalog lesson is missing an id");
      if (ids.has(lessonId)) {
        throw new Error(`Duplicate lesson id: ${lessonId}`);
      }
      ids.add(lessonId);

      if (!String(lesson?.title || "").trim()) {
        throw new Error(`Catalog lesson ${lessonId} is missing title`);
      }
      if (lesson?.accessible !== false || String(lesson?.pageUrl || "").trim()) {
        validateLessonUrl(lesson?.pageUrl);
      }
    }
    validateLessonNumberOrder(lessons);
    return true;
  }

  function normalizeCatalogSnapshot(snapshot, pageUrl) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("Catalog snapshot is missing");
    }
    validateDeclaredTotal(snapshot.total);

    let origin;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      throw new Error("Catalog page URL is invalid");
    }

    const courseId = extractProductId(snapshot, pageUrl);
    if (!courseId) throw new Error("Catalog product id is missing");

    const sourceItems = snapshot.columnList ?? snapshot.items;
    if (!Array.isArray(sourceItems)) {
      throw new Error("Catalog snapshot has no lesson list");
    }

    const lessons = sourceItems.map((item, position) => {
      const lessonId = String(item?.resource_id || "").trim();
      const title = String(item?.resource_title || "").trim();
      const order = position + 1;
      const lessonNumber = parseLessonNumber(title);
      const jumpUrl = String(item?.jump_url || "").trim();
      let resolvedUrl = "";
      if (jumpUrl) {
        try {
          resolvedUrl = new URL(jumpUrl, `${origin}/`).href;
        } catch {
          throw new Error("Catalog lesson has a missing or invalid link");
        }
      }

      return {
        lessonId,
        order,
        lessonNumber,
        index: lessonNumber ?? order,
        title,
        pageUrl: resolvedUrl,
        accessible: Boolean(resolvedUrl),
        resourceType: item?.resource_type,
        diagnostics: {
          canView: item?.can_view,
          isTry: item?.is_try,
        },
      };
    });

    validateCompleteCatalog(lessons, snapshot.total);
    return { courseId, total: snapshot.total, lessons };
  }

  return {
    extractProductId,
    normalizeCatalogSnapshot,
    parseLessonNumber,
    validateCompleteCatalog,
  };
});
