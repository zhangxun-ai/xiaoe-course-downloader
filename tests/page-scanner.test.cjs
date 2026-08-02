const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scanner = fs.readFileSync(
  path.join(__dirname, "..", "content-scripts", "page-scanner.js"),
  "utf8",
);

function scanPage(audio = null) {
  return vm.runInNewContext(scanner, {
    URL,
    location: { href: "https://school.example.test/course/lesson" },
    performance: {
      timeOrigin: 1_000,
      getEntriesByType: () => [],
    },
    document: {
      title: "Lesson - 小鹅通",
      querySelector(selector) {
        if (selector === "audio") return audio;
        return null;
      },
      querySelectorAll: () => [],
    },
  });
}

test("does not treat an empty audio attribute as the current course page", () => {
  const result = scanPage({
    currentSrc: "",
    src: "",
    getAttribute: () => "",
  });

  assert.equal(result.candidates.length, 0);
});
