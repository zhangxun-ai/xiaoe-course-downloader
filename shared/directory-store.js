(function attachDirectoryStore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XiaoeDirectoryStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDirectoryStoreModule() {
  "use strict";

  const DEFAULT_DATABASE = "xiaoe-course-downloader";
  const STORE_NAME = "directory-handles";

  function asPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function openDatabase(indexedDB, databaseName) {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    return asPromise(request);
  }

  function completeTransaction(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function validJobId(jobId) {
    const value = String(jobId || "").trim();
    if (!value) throw new Error("Directory handle requires jobId");
    return value;
  }

  function validDirectoryHandle(handle) {
    if (!handle || handle.kind !== "directory") throw new Error("Expected a directory handle (FileSystemDirectoryHandle)");
    return handle;
  }

  function createDirectoryStore(options = {}) {
    const indexedDB = options.indexedDB || globalThis.indexedDB;
    if (!indexedDB?.open) throw new Error("IndexedDB is unavailable");
    const databaseName = options.databaseName || DEFAULT_DATABASE;
    let databasePromise;

    function database() {
      databasePromise ||= openDatabase(indexedDB, databaseName);
      return databasePromise;
    }

    async function transact(mode, operation) {
      const db = await database();
      const transaction = db.transaction(STORE_NAME, mode);
      const completion = completeTransaction(transaction);
      const result = await asPromise(operation(transaction.objectStore(STORE_NAME)));
      await completion;
      return result;
    }

    async function save(jobId, handle) {
      const key = validJobId(jobId);
      validDirectoryHandle(handle);
      await transact("readwrite", (store) => store.put(handle, key));
      return handle;
    }

    async function load(jobId, permission = { mode: "readwrite" }) {
      const handle = await transact("readonly", (store) => store.get(validJobId(jobId)));
      if (!handle) return null;
      validDirectoryHandle(handle);
      const options = { mode: permission.mode || "readwrite" };
      let state = await handle.queryPermission(options);
      if (state === "prompt") state = await handle.requestPermission(options);
      if (state !== "granted") throw new Error("Directory permission was not granted");
      return handle;
    }

    async function remove(jobId) {
      await transact("readwrite", (store) => store.delete(validJobId(jobId)));
    }

    return { delete: remove, load, save };
  }

  return { createDirectoryStore };
});
