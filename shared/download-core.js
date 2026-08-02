(function attachDownloadCore(root, factory) {
  const hls =
    typeof module === "object" && module.exports
      ? require("./hls.js")
      : root.XiaoeHls;
  const api = factory(hls);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.XiaoeDownloadCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createDownloadCore(hls) {
  "use strict";

  function requireHttpUrl(value, label = "媒体") {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(label + "地址必须是 HTTP(S) URL");
    }
    return url.href;
  }

  async function fetchMedia(fetchImpl, url) {
    const response = await fetchImpl(requireHttpUrl(url), {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `媒体请求返回 ${response.status}。登录凭据可能已过期，或服务器要求当前扩展无法安全复现的 Referer。`,
      );
    }
    if (!response.ok) {
      throw new Error(`媒体请求失败：HTTP ${response.status}`);
    }
    return response;
  }

  async function writeResponseBody(response, writable, onProgress, initialBytes = 0) {
    if (!response.body) return initialBytes;
    const reader = response.body.getReader();
    let bytesWritten = initialBytes;
    const contentLength = Number(response.headers.get("content-length")) || 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      await writable.write(value);
      bytesWritten += value.byteLength;
      onProgress?.({ bytesWritten, contentLength });
    }
    return bytesWritten;
  }

  function isClearlyNonMediaResponse(response) {
    const contentType = String(response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    return contentType === "text/html"
      || contentType === "application/json"
      || contentType.endsWith("+json");
  }

  function createRequestPool(maxConcurrency = 5) {
    const limit = Math.max(1, Number(maxConcurrency) || 1);
    let active = 0;
    const queued = [];
    const dispatch = () => {
      while (active < limit && queued.length) {
        const next = queued.shift();
        active += 1;
        Promise.resolve()
          .then(next.operation)
          .then(next.resolve, next.reject)
          .finally(() => {
            active -= 1;
            dispatch();
          });
      }
    };
    return {
      run(operation) {
        return new Promise((resolve, reject) => {
          queued.push({ operation, resolve, reject });
          dispatch();
        });
      },
    };
  }

  async function writeDirectMedia(url, fetchImpl, writable, onProgress, options = {}) {
    try {
      const response = await fetchMedia(fetchImpl, url);
      if (isClearlyNonMediaResponse(response)) {
        throw new Error("媒体地址返回了非媒体内容（HTML 或 JSON）");
      }
      const bytesWritten = await writeResponseBody(response, writable, onProgress);
      if (bytesWritten <= 0) throw new Error("服务器返回了零字节媒体文件");
      if (options.close !== false) await writable.close();
      return { bytesWritten };
    } catch (error) {
      try {
        await writable.abort();
      } catch {
        // Preserve the original download error.
      }
      throw error;
    }
  }

  async function loadHlsPlan(url, fetchImpl) {
    let playlistUrl = url;
    for (let depth = 0; depth < 4; depth += 1) {
      const response = await fetchMedia(fetchImpl, playlistUrl);
      const playlist = hls.parseHlsPlaylist(await response.text(), playlistUrl);
      if (playlist.kind === "media") {
        return {
          extension: playlist.extension,
          resources: playlist.resources,
        };
      }
      playlistUrl = playlist.variantUrl;
    }
    throw new Error("HLS 主播放列表嵌套过深");
  }

  async function writeHlsResources(resources, fetchImpl, writable, onProgress, options = {}) {
    let bytesWritten = 0;
    const cryptoImpl = options.cryptoImpl || globalThis.crypto;
    const keyCache = new Map();
    const maxConcurrency = Math.max(1, Math.min(5, Number(options.maxConcurrency) || 5));
    const requestPool = options.requestPool || createRequestPool(maxConcurrency);
    const request = (url) => requestPool.run(() => fetchMedia(fetchImpl, url));
    async function importedKey(keyUrl) {
      if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
      const pending = (async () => {
        const response = await request(keyUrl);
        const keyBytes = new Uint8Array(await response.arrayBuffer());
        if (keyBytes.byteLength !== 16) throw new Error("AES-128 key 必须是 16 字节");
        if (!cryptoImpl?.subtle) throw new Error("当前浏览器不支持 Web Crypto");
        return cryptoImpl.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
      })();
      keyCache.set(keyUrl, pending);
      try {
        return await pending;
      } catch (error) {
        keyCache.delete(keyUrl);
        throw error;
      }
    }
    async function loadResource(entry) {
      const resource = typeof entry === "string"
        ? { url: entry, kind: "media" }
        : entry;
      const response = await request(resource?.url);
      if (isClearlyNonMediaResponse(response)) {
        throw new Error("HLS 分片返回了非媒体内容（HTML 或 JSON）");
      }
      if (!resource?.keyUrl) return new Uint8Array(await response.arrayBuffer());
      const encrypted = new Uint8Array(await response.arrayBuffer());
      if (!encrypted.byteLength || encrypted.byteLength % 16 !== 0) {
        throw new Error("AES-128 分片长度必须是 16 的倍数");
      }
      if (!(resource.iv instanceof Uint8Array) || resource.iv.byteLength !== 16) {
        throw new Error("AES-128 分片缺少有效 IV");
      }
      const plaintext = new Uint8Array(await cryptoImpl.subtle.decrypt(
        { name: "AES-CBC", iv: resource.iv },
        await importedKey(resource.keyUrl),
        encrypted,
      ));
      if (!plaintext.byteLength) throw new Error("AES-128 分片解密后为空");
      return plaintext;
    }
    try {
      const pending = new Map();
      let nextIndex = 0;
      const prefetch = () => {
        if (nextIndex >= resources.length) return;
        const index = nextIndex;
        nextIndex += 1;
        pending.set(index, loadResource(resources[index]));
      };
      while (pending.size < maxConcurrency && nextIndex < resources.length) prefetch();
      for (let index = 0; index < resources.length; index += 1) {
        const bytes = await pending.get(index);
        pending.delete(index);
        prefetch();
        if (bytes.byteLength) {
          await writable.write(bytes);
          bytesWritten += bytes.byteLength;
        }
        onProgress?.({
          bytesWritten,
          contentLength: 0,
          resourceIndex: index + 1,
          resourceCount: resources.length,
        });
      }
      if (bytesWritten <= 0) throw new Error("HLS 播放列表返回了零字节媒体文件");
      if (options.close !== false) await writable.close();
      return { bytesWritten };
    } catch (error) {
      try {
        await writable.abort();
      } catch {
        // Preserve the original download error.
      }
      throw error;
    }
  }

  return {
    fetchMedia,
    createRequestPool,
    isClearlyNonMediaResponse,
    loadHlsPlan,
    writeDirectMedia,
    writeHlsResources,
  };
});
