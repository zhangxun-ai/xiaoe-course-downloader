(function attachHlsUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XiaoeHls = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createHlsUtils() {
  "use strict";

  function readAttribute(line, name) {
    const expression = new RegExp("(?:^|,)" + name + "=(?:\"([^\"]*)\"|([^,]*))", "i");
    const match = line.match(expression);
    return match ? (match[1] ?? match[2] ?? "").trim() : "";
  }

  function resolveHttpUrl(value, baseUrl, label = "资源") {
    const url = new URL(value, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(label + "地址必须是 HTTP(S) URL");
    return url.href;
  }

  function parseIv(value) {
    const hex = String(value || "").trim();
    if (!/^0x[0-9a-f]{32}$/i.test(hex)) throw new Error("AES-128 IV 必须是 16 字节十六进制值");
    const iv = new Uint8Array(16);
    for (let index = 0; index < iv.length; index += 1) {
      iv[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
    }
    return iv;
  }

  function sequenceIv(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("EXT-X-MEDIA-SEQUENCE 必须是非负整数");
    const iv = new Uint8Array(16);
    let value = BigInt(sequence);
    for (let index = 15; index >= 0; index -= 1) {
      iv[index] = Number(value & 0xffn);
      value >>= 8n;
    }
    return iv;
  }

  function outputExtension(resources) {
    if (resources.some((resource) => resource.kind === "map")) return "mp4";
    let extension = "";
    try {
      extension = new URL(resources.find((resource) => resource.kind === "media")?.url || "").pathname.split(".").pop().toLowerCase();
    } catch {}
    if (extension === "aac") return "aac";
    if (extension === "m4s" || extension === "mp4" || extension === "m4a") return "mp4";
    return "ts";
  }

  function nextUri(lines, startIndex) {
    for (let index = startIndex; index < lines.length; index += 1) {
      if (lines[index] && !lines[index].startsWith("#")) return lines[index];
    }
    return "";
  }

  function parseMaster(lines, baseUrl) {
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
      const uri = nextUri(lines, index + 1);
      if (!uri) throw new Error("HLS 主播放列表缺少变体地址");
      variants.push({
        bandwidth: Number(readAttribute(lines[index].slice(lines[index].indexOf(":") + 1), "BANDWIDTH")) || 0,
        url: resolveHttpUrl(uri, baseUrl, "HLS 变体"),
      });
    }
    if (!variants.length) return null;
    variants.sort((left, right) => right.bandwidth - left.bandwidth);
    return { kind: "master", variantUrl: variants[0].url };
  }

  function parseKey(attributes, baseUrl) {
    const method = readAttribute(attributes, "METHOD").toUpperCase();
    if (method === "NONE") return null;
    if (method !== "AES-128") throw new Error("第一版不支持加密 HLS（" + (method || "未知方法") + "）");
    const keyFormat = readAttribute(attributes, "KEYFORMAT");
    if (keyFormat && keyFormat.toLowerCase() !== "identity") throw new Error("第一版不支持非 identity KEYFORMAT");
    const uri = readAttribute(attributes, "URI");
    if (!uri) throw new Error("AES-128 播放列表缺少 key URI");
    const explicitIv = readAttribute(attributes, "IV");
    return { keyUrl: resolveHttpUrl(uri, baseUrl, "AES-128 key"), explicitIv: explicitIv ? parseIv(explicitIv) : null };
  }

  function parseMedia(lines, baseUrl) {
    if (!lines.includes("#EXT-X-ENDLIST")) throw new Error("第一版不支持直播或尚未结束的 HLS 播放列表");
    if (lines.some((line) => line.startsWith("#EXT-X-BYTERANGE:"))) throw new Error("第一版不支持 EXT-X-BYTERANGE");
    const resources = [];
    let mediaSequence = 0;
    let activeKey = null;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = Number(line.slice(line.indexOf(":") + 1));
        if (!Number.isSafeInteger(mediaSequence) || mediaSequence < 0) throw new Error("EXT-X-MEDIA-SEQUENCE 必须是非负整数");
      } else if (line.startsWith("#EXT-X-KEY:")) {
        activeKey = parseKey(line.slice(line.indexOf(":") + 1), baseUrl);
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attributes = line.slice(line.indexOf(":") + 1);
        if (readAttribute(attributes, "BYTERANGE")) throw new Error("第一版不支持 EXT-X-MAP BYTERANGE");
        const uri = readAttribute(attributes, "URI");
        if (!uri) throw new Error("HLS 初始化分片缺少 URI");
        const mapIv = readAttribute(attributes, "IV");
        if (activeKey && !mapIv) throw new Error("加密 EXT-X-MAP 必须提供显式 IV");
        resources.push({
          url: resolveHttpUrl(uri, baseUrl, "HLS 初始化分片"),
          kind: "map",
          ...(activeKey ? { keyUrl: activeKey.keyUrl, iv: parseIv(mapIv) } : {}),
        });
      } else if (line && !line.startsWith("#")) {
        const resource = { url: resolveHttpUrl(line, baseUrl, "HLS 分片"), kind: "media" };
        if (activeKey) {
          resource.keyUrl = activeKey.keyUrl;
          resource.iv = activeKey.explicitIv || sequenceIv(mediaSequence);
        }
        resources.push(resource);
        mediaSequence += 1;
      }
    }
    if (!resources.length) throw new Error("HLS 播放列表中没有媒体分片");
    return { kind: "media", extension: outputExtension(resources), resources };
  }

  function parseHlsPlaylist(text, baseUrl) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") throw new Error("响应不是有效的 HLS 播放列表");
    if (lines.some((line) => line.startsWith("#EXT-X-SESSION-KEY:"))) throw new Error("第一版不支持 EXT-X-SESSION-KEY");
    return parseMaster(lines, baseUrl) || parseMedia(lines, baseUrl);
  }

  return { parseHlsPlaylist };
});
