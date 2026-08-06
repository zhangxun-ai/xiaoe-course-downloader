(function attachTabResolver(root, factory) {
  const mediaUtils =
    typeof module === "object" && module.exports
      ? require("./media-utils.js")
      : root.XiaoeMediaUtils;
  const api = factory(mediaUtils);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XiaoeTabResolver = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createResolverModule(mediaUtils) {
  "use strict";

  const DEFAULT_TIMEOUT_MS = 15_000;
  const DEFAULT_POLL_INTERVAL_MS = 250;
  const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;

  function defaultSleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function decodeContentPagePayload(encoded) {
    const value = String(encoded || "");
    const base64 = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function directlyLoadableXiaoeUrl(url) {
    const match = url.pathname.match(/^\/content_page\/([^/]+)\/?$/);
    if (!match) return url;
    try {
      const payload = decodeContentPagePayload(match[1]);
      const resourceId = String(payload?.resource_id || "").trim();
      const productId = String(payload?.product_id || "").trim();
      const resourceType = Number(payload?.resource_type);
      const detailType = resourceType === 2
        ? "audio"
        : resourceType === 3
          ? "video"
          : "";
      if (!detailType || !resourceId || !productId) {
        return url;
      }
      const direct = new URL(
        `/p/t_pc/course_pc_detail/${detailType}/${encodeURIComponent(resourceId)}`,
        url.origin,
      );
      direct.searchParams.set("product_id", productId);
      return direct;
    } catch {
      return url;
    }
  }

  function normalizedPageUrl(value) {
    let url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("课程链接必须是 HTTP(S) URL");
    }
    url = directlyLoadableXiaoeUrl(url);
    return url.href;
  }

  function asEpoch(value, fallback) {
    const epoch = Number(value);
    return Number.isFinite(epoch) && epoch >= 0 ? epoch : fallback;
  }

  function currentNetworkCandidates(response, requestedEpoch) {
    const responseEpoch = asEpoch(response?.navigationStartedAt, -1);
    if (responseEpoch < requestedEpoch) {
      return { navigationStartedAt: requestedEpoch, candidates: [] };
    }
    return {
      navigationStartedAt: responseEpoch,
      candidates: (response?.candidates || []).filter((candidate) => {
        const candidateEpoch = asEpoch(
          candidate?.navigationStartedAt,
          responseEpoch,
        );
        const capturedAt = asEpoch(candidate?.capturedAt, -1);
        return candidateEpoch === responseEpoch && capturedAt >= responseEpoch;
      }),
    };
  }

  function uniqueRankedCandidates(candidates) {
    const byUrl = new Map();
    for (const candidate of candidates || []) {
      const ranked = mediaUtils.selectBestCandidate([candidate]);
      if (!ranked) continue;
      const previous = byUrl.get(ranked.url);
      if (
        !previous ||
        ranked.score > previous.score ||
        (ranked.score === previous.score &&
          asEpoch(ranked.capturedAt, -1) > asEpoch(previous.capturedAt, -1))
      ) {
        byUrl.set(ranked.url, ranked);
      }
    }
    return [...byUrl.values()];
  }

  function candidateDecision(domCandidates, networkCandidates) {
    const directDom = uniqueRankedCandidates((domCandidates || []).filter((candidate) => {
      if (candidate?.source !== "dom") return false;
      return mediaUtils.classifyMediaUrl(candidate?.url, candidate?.mime)?.kind === "direct";
    }));
    if (directDom.length === 1) {
      return { candidate: directDom[0], ambiguous: false };
    }
    if (directDom.length > 1) {
      return { candidate: null, ambiguous: true };
    }

    const ranked = uniqueRankedCandidates([
      ...(domCandidates || []),
      ...(networkCandidates || []),
    ]);
    if (!ranked.length) return { candidate: null, ambiguous: false };
    const highestScore = Math.max(...ranked.map((candidate) => candidate.score));
    let finalists = ranked.filter((candidate) => candidate.score === highestScore);
    if (finalists.length > 1 && finalists.every((candidate) => candidate.source === "network")) {
      const newestCapturedAt = Math.max(
        ...finalists.map((candidate) => asEpoch(candidate.capturedAt, -1)),
      );
      finalists = finalists.filter(
        (candidate) => asEpoch(candidate.capturedAt, -1) === newestCapturedAt,
      );
    }
    return finalists.length === 1
      ? { candidate: finalists[0], ambiguous: false }
      : { candidate: null, ambiguous: true };
  }

  function selectCandidate(domCandidates, networkCandidates) {
    return candidateDecision(domCandidates, networkCandidates).candidate;
  }

  function createTabResolver(adapter, options = {}) {
    for (const method of [
      "createTab",
      "clearCandidates",
      "waitForComplete",
      "scanPage",
      "getCandidates",
      "closeTab",
    ]) {
      if (typeof adapter?.[method] !== "function") {
        throw new Error(`Tab resolver adapter requires ${method}()`);
      }
    }
    if (!mediaUtils) throw new Error("Tab resolver requires media utilities");

    const now = options.now || Date.now;
    const sleep = options.sleep || defaultSleep;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    const setTimer = options.setTimeoutFn || setTimeout;
    const clearTimer = options.clearTimeoutFn || clearTimeout;

    function timeoutError() {
      return new Error("媒体解析超时（15 秒）");
    }

    function beforeDeadline(operation, deadline) {
      const remaining = deadline - now();
      if (remaining <= 0) return Promise.reject(timeoutError());
      const pending = Promise.resolve().then(operation);
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => reject(timeoutError()), remaining);
        pending.then(
          (value) => {
            clearTimer(timer);
            if (now() >= deadline) reject(timeoutError());
            else resolve(value);
          },
          (error) => {
            clearTimer(timer);
            reject(error);
          },
        );
      });
    }

    function closeBestEffort(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve();
      const pending = Promise.resolve().then(() => adapter.closeTab(tabId));
      return new Promise((resolve) => {
        const timer = setTimer(resolve, closeTimeoutMs);
        const finish = () => {
          clearTimer(timer);
          resolve();
        };
        pending.then(finish, finish);
      });
    }

    async function resolve(pageUrl) {
      const startedAt = now();
      const deadline = startedAt + timeoutMs;
      const targetUrl = normalizedPageUrl(pageUrl);
      const resolvesVideo = /\/p\/t_pc\/course_pc_detail\/video\//.test(
        new URL(targetUrl).pathname,
      );
      const createPending = Promise.resolve().then(() => adapter.createTab({
        url: targetUrl,
        active: resolvesVideo,
      }));
      let tab;
      try {
        tab = await beforeDeadline(() => createPending, deadline);
      } catch (error) {
        void createPending.then((lateTab) => {
          if (Number.isInteger(lateTab?.id) && lateTab.id >= 0) {
            return closeBestEffort(lateTab.id);
          }
          return undefined;
        }).catch(() => {});
        throw error;
      }
      if (!Number.isInteger(tab?.id) || tab.id < 0) {
        throw new Error("无法创建课程解析标签页");
      }

      const tabId = tab.id;
      try {
        const cleared = await beforeDeadline(
          () => adapter.clearCandidates(tabId, startedAt),
          deadline,
        );
        let navigationStartedAt = Math.max(
          startedAt,
          asEpoch(cleared?.navigationStartedAt, startedAt),
        );
        await beforeDeadline(
          () => adapter.waitForComplete(tabId, {
            deadline,
            timeoutMs: Math.max(0, deadline - now()),
            navigationStartedAt,
          }),
          deadline,
        );
        let ambiguousCandidatesSeen = false;

        while (now() < deadline) {
          if (resolvesVideo && typeof adapter.activateMedia === "function") {
            await beforeDeadline(() => adapter.activateMedia(tabId), deadline);
          }
          const scannedEpoch = navigationStartedAt;
          const scan = await beforeDeadline(
            () => adapter.scanPage(tabId),
            deadline,
          );
          const network = currentNetworkCandidates(
            await beforeDeadline(
              () => adapter.getCandidates(tabId, navigationStartedAt),
              deadline,
            ),
            navigationStartedAt,
          );
          navigationStartedAt = network.navigationStartedAt;
          const scanNavigationStartedAt = asEpoch(
            scan?.navigationStartedAt,
            -1,
          );
          const scannedTargetPage = String(scan?.pageUrl || "") === targetUrl;
          const domCandidates =
            scannedTargetPage || (
              scanNavigationStartedAt >= scannedEpoch &&
              scanNavigationStartedAt >= navigationStartedAt
            )
            ? scan?.candidates
            : [];
          const decision = candidateDecision(domCandidates, network.candidates);
          const selected = decision.candidate;
          ambiguousCandidatesSeen ||= decision.ambiguous;
          if (selected) {
            return {
              ...selected,
              title: String(scan?.title || "").trim(),
              navigationStartedAt,
            };
          }

          const remaining = deadline - now();
          if (remaining <= 0) break;
          await sleep(Math.min(pollIntervalMs, remaining));
        }
        if (ambiguousCandidatesSeen) {
          throw new Error("媒体候选不唯一，无法安全选择");
        }
        throw timeoutError();
      } finally {
        await closeBestEffort(tabId);
      }
    }

    return { resolve };
  }

  return {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_CLOSE_TIMEOUT_MS,
    candidateDecision,
    createTabResolver,
    currentNetworkCandidates,
    normalizedPageUrl,
    selectCandidate,
  };
});
