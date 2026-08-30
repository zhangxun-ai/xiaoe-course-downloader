const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function readPngDimensions(filename) {
  const png = fs.readFileSync(path.join(root, filename));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

test("manifest is an isolated MV3 extension with the minimum required permissions", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "scripting", "storage", "webRequest"].sort(),
  );
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.permissions.includes("tabs"), false);
});

test("manifest declares complete extension artwork with valid PNG dimensions", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  const expectedIcons = {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  };

  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action.default_icon, {
    16: expectedIcons[16],
    32: expectedIcons[32],
  });
  assert.equal(fs.existsSync(path.join(root, "icons/icon-source.svg")), true);

  for (const [size, filename] of Object.entries(expectedIcons)) {
    assert.deepEqual(readPngDimensions(filename), {
      width: Number(size),
      height: Number(size),
    });
  }
});

test("every extension entry point referenced by the manifest exists", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  const referencedFiles = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    "popup.css",
    "popup.js",
    "content-scripts/page-scanner.js",
    "content-scripts/catalog-scanner.js",
    "shared/media-utils.js",
    "shared/hls.js",
    "shared/download-core.js",
    "shared/catalog.js",
    "shared/catalog-loader.js",
    "shared/batch-state.js",
    "shared/batch-scheduler.js",
    "shared/job-store.js",
    "shared/directory-store.js",
    "shared/batch-files.js",
    "shared/tab-resolver.js",
    "shared/batch-runner-core.js",
    "downloader.html",
    "downloader.css",
    "downloader.js",
    "batch-runner.html",
    "batch-runner.css",
    "batch-runner.js",
  ];

  for (const filename of referencedFiles) {
    assert.equal(fs.existsSync(path.join(root, filename)), true, `${filename} is missing`);
  }
});

test("popup exposes batch catalog discovery and injects loader then scanner in MAIN world", () => {
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  const store = fs.readFileSync(path.join(root, "shared/job-store.js"), "utf8");

  assert.match(html, /id="batchScanButton"/);
  assert.match(html, /shared\/catalog\.js/);
  assert.match(html, /shared\/job-store\.js/);
  const loader = source.indexOf('files: ["shared/catalog-loader.js"]');
  const scanner = source.indexOf('files: ["content-scripts/catalog-scanner.js"]');
  assert.ok(loader >= 0 && scanner > loader);
  assert.match(source, /world:\s*"MAIN"/);
  assert.match(store, /batchJobIndex:/);
  assert.match(source, /batch-runner\.html/);
});

test("batch runner loads dependencies locally and offers full, checkpoint, stop, retry, and overwrite controls", () => {
  const html = fs.readFileSync(path.join(root, "batch-runner.html"), "utf8");
  for (const reference of [
    "shared/batch-state.js",
    "shared/batch-scheduler.js",
    "shared/directory-store.js",
    "shared/batch-files.js",
    "shared/tab-resolver.js",
    "shared/batch-runner-core.js",
    "batch-runner.js",
  ]) {
    assert.match(html, new RegExp(reference.replace(/[.]/g, "\\.")));
  }
  for (const id of ["startAllButton", "checkpointButton", "stopButton", "retryButton", "overwriteButton"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});
