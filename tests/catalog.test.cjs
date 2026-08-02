const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/xiaoe-catalog-snapshot.json");

const {
  extractProductId,
  normalizeCatalogSnapshot,
  parseLessonNumber,
  validateCompleteCatalog,
} = require("../shared/catalog.js");

const pageUrl =
  "https://school.example.com/p/t_pc/course_pc_detail/audio/current?product_id=query_product";

function copyFixture() {
  return JSON.parse(JSON.stringify(fixture));
}

function fixtureWithTitles(titles) {
  const snapshot = copyFixture();
  titles.forEach((title, index) => {
    snapshot.columnList[index].resource_title = title;
  });
  return snapshot;
}

test("normalizes the sanitized snapshot with an exact declared total", () => {
  const catalog = normalizeCatalogSnapshot(copyFixture(), pageUrl);

  assert.equal(catalog.courseId, "product_sanitized_001");
  assert.equal(catalog.total, 3);
  assert.equal(catalog.lessons.length, 3);
  assert.deepEqual(catalog.lessons[0], {
    lessonId: "lesson_sanitized_065",
    order: 1,
    lessonNumber: 65,
    index: 65,
    title: "65. 体制内的思考",
    pageUrl:
      "https://school.example.com/p/t_pc/course_pc_detail/audio/lesson_sanitized_065",
    accessible: true,
    resourceType: 2,
    diagnostics: { canView: 0, isTry: 0 },
  });
});

test("accepts strictly ascending lesson numbers", () => {
  const catalog = normalizeCatalogSnapshot(
    fixtureWithTitles(["65. 体制内的思考", "66. 第二课", "67. 第三课"]),
    pageUrl,
  );

  assert.deepEqual(
    catalog.lessons.map(({ order, lessonNumber, index }) => ({
      order,
      lessonNumber,
      index,
    })),
    [
      { order: 1, lessonNumber: 65, index: 65 },
      { order: 2, lessonNumber: 66, index: 66 },
      { order: 3, lessonNumber: 67, index: 67 },
    ],
  );
});

test("accepts the real Xiaoetong descending catalog order", () => {
  const catalog = normalizeCatalogSnapshot(
    fixtureWithTitles(["88. 最新课", "87. 上一课", "86. 更早课"]),
    pageUrl,
  );

  assert.deepEqual(
    catalog.lessons.map((lesson) => lesson.lessonNumber),
    [88, 87, 86],
  );
  assert.deepEqual(catalog.lessons.map((lesson) => lesson.order), [1, 2, 3]);
});

test("rejects duplicate lesson numbers", () => {
  assert.throws(
    () =>
      normalizeCatalogSnapshot(
        fixtureWithTitles(["88. 最新课", "87. 上一课", "87. 重复编号"]),
        pageUrl,
      ),
    /duplicate lesson number/i,
  );
});

test("rejects a reversal in lesson-number direction", () => {
  assert.throws(
    () =>
      normalizeCatalogSnapshot(
        fixtureWithTitles(["88. 最新课", "87. 上一课", "89. 方向反转"]),
        pageUrl,
      ),
    /lesson number.*direction/i,
  );
});

test("ignores unnumbered lessons when validating direction", () => {
  const catalog = normalizeCatalogSnapshot(
    fixtureWithTitles(["88. 最新课", "课程导语", "87. 上一课"]),
    pageUrl,
  );

  assert.deepEqual(
    catalog.lessons.map(({ order, lessonNumber, index }) => ({
      order,
      lessonNumber,
      index,
    })),
    [
      { order: 1, lessonNumber: 88, index: 88 },
      { order: 2, lessonNumber: null, index: 2 },
      { order: 3, lessonNumber: 87, index: 87 },
    ],
  );
});

test("uses jump_url alone for initial selection and keeps access flags diagnostic", () => {
  const catalog = normalizeCatalogSnapshot(copyFixture(), pageUrl);

  assert.equal(catalog.lessons[0].accessible, true);
  assert.equal(catalog.lessons[0].diagnostics.canView, 0);
  assert.equal(catalog.lessons[1].accessible, true);
  assert.equal(catalog.lessons[1].diagnostics.isTry, 1);
});

test("rejects duplicate lesson identifiers", () => {
  const snapshot = copyFixture();
  snapshot.columnList[2].resource_id = snapshot.columnList[0].resource_id;

  assert.throws(
    () => normalizeCatalogSnapshot(snapshot, pageUrl),
    /duplicate lesson id/i,
  );
});

test("rejects a lesson with a missing title", () => {
  const snapshot = copyFixture();
  snapshot.columnList[1].resource_title = "  ";

  assert.throws(
    () => normalizeCatalogSnapshot(snapshot, pageUrl),
    /missing title/i,
  );
});

test("keeps a lesson without jump_url in the exact catalog but disables selection", () => {
  const snapshot = copyFixture();
  snapshot.columnList[1].jump_url = "";

  const catalog = normalizeCatalogSnapshot(snapshot, pageUrl);

  assert.equal(catalog.total, 3);
  assert.equal(catalog.lessons.length, 3);
  assert.equal(catalog.lessons[1].pageUrl, "");
  assert.equal(catalog.lessons[1].accessible, false);
  assert.deepEqual(catalog.lessons[1].diagnostics, { canView: 1, isTry: 1 });
});

test("rejects a malformed lesson link", () => {
  const snapshot = copyFixture();
  snapshot.columnList[1].jump_url = "http://[";

  assert.throws(
    () => normalizeCatalogSnapshot(snapshot, pageUrl),
    /missing or invalid link/i,
  );
});

test("rejects partial, overflowed, and invalid declared totals", () => {
  for (const total of [2, 4, 0, "3"]) {
    const snapshot = copyFixture();
    snapshot.total = total;
    assert.throws(
      () => normalizeCatalogSnapshot(snapshot, pageUrl),
      /declared total|exactly/i,
    );
  }
});

test("exports product-id, lesson-number, and completeness helpers", () => {
  assert.equal(extractProductId(copyFixture(), pageUrl), "product_sanitized_001");
  assert.equal(
    extractProductId({}, "https://school.example.com/course?product_id=from_query"),
    "from_query",
  );
  assert.equal(parseLessonNumber("65. 体制内的思考"), 65);
  assert.equal(parseLessonNumber("没有编号"), null);
  assert.equal(
    validateCompleteCatalog(
      [
        { lessonId: "one", title: "One", pageUrl: "https://school.example/one" },
        { lessonId: "two", title: "Two", pageUrl: "https://school.example/two" },
      ],
      2,
    ),
    true,
  );
});
