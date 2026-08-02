importScripts("shared/media-utils.js");

const CANDIDATE_PREFIX = "mediaCandidates:";
const MAX_CANDIDATES_PER_TAB = 80;
const mutationQueues = new Map();

function storageKey(tabId) {
  return `${CANDIDATE_PREFIX}${tabId}`;
}

function responseMime(headers = []) {
  const header = headers.find(
    (item) => String(item.name || "").toLowerCase() === "content-type",
  );
  return String(header?.value || "").split(";", 1)[0].trim().toLowerCase();
}

function normalizedEpoch(value, fallback = 0) {
  const epoch = Number(value);
  return Number.isFinite(epoch) && epoch >= 0 ? epoch : fallback;
}

function queueMutation(tabId, mutation) {
  const previous = mutationQueues.get(tabId) || Promise.resolve();
  const queued = previous.catch(() => {}).then(mutation);
  mutationQueues.set(tabId, queued);
  return queued.finally(() => {
    if (mutationQueues.get(tabId) === queued) mutationQueues.delete(tabId);
  });
}

async function readCandidateState(tabId) {
  await (mutationQueues.get(tabId) || Promise.resolve()).catch(() => {});
  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const value = stored[key];
  if (Array.isArray(value)) {
    return { navigationStartedAt: 0, candidates: value };
  }
  return {
    navigationStartedAt: normalizedEpoch(value?.navigationStartedAt),
    candidates: Array.isArray(value?.candidates) ? value.candidates : [],
  };
}

async function clearCandidates(tabId, navigationStartedAt = Date.now()) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { navigationStartedAt: 0 };
  }
  const requestedEpoch = normalizedEpoch(navigationStartedAt, Date.now());
  return queueMutation(tabId, async () => {
    const key = storageKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const currentEpoch = normalizedEpoch(stored[key]?.navigationStartedAt);
    // A newer main-frame navigation already cleared this tab and may already
    // have captured its first media request. Do not erase those fresh results
    // with the resolver's older, post-create cleanup request.
    if (currentEpoch > requestedEpoch) {
      return { navigationStartedAt: currentEpoch };
    }
    const epoch = Math.max(currentEpoch, requestedEpoch);
    await chrome.storage.session.set({
      [key]: { navigationStartedAt: epoch, candidates: [] },
    });
    return { navigationStartedAt: epoch };
  });
}

async function removeCandidates(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  await queueMutation(tabId, () => chrome.storage.session.remove(storageKey(tabId)));
}

async function rememberCandidate(details) {
  if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
  const headerMime = responseMime(details.responseHeaders);
  const effectiveMime = headerMime;
  const classification = XiaoeMediaUtils.classifyMediaUrl(
    details.url,
    effectiveMime,
  );
  if (!classification) return;

  await queueMutation(details.tabId, async () => {
    const key = storageKey(details.tabId);
    const stored = await chrome.storage.session.get(key);
    const state = stored[key] || {};
    const navigationStartedAt = normalizedEpoch(state.navigationStartedAt);
    const capturedAt = normalizedEpoch(details.timeStamp, Date.now());
    if (capturedAt < navigationStartedAt) return;
    const candidates = Array.isArray(state.candidates) ? state.candidates : [];
    const next = [
      ...candidates.filter((item) => item.url !== details.url),
      {
        url: details.url,
        mime: effectiveMime,
        source: "network",
        capturedAt,
        navigationStartedAt,
      },
    ].slice(-MAX_CANDIDATES_PER_TAB);
    await chrome.storage.session.set({
      [key]: { navigationStartedAt, candidates: next },
    });
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    void clearCandidates(details.tabId, details.timeStamp);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    void rememberCandidate(details);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeCandidates(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !Number.isInteger(message.tabId)) return false;
  if (message.type === "GET_MEDIA_CANDIDATES") {
    readCandidateState(message.tabId)
      .then((state) => {
        const requestedEpoch = normalizedEpoch(message.navigationStartedAt);
        const navigationStartedAt = state.navigationStartedAt;
        const candidates = navigationStartedAt < requestedEpoch
          ? []
          : state.candidates.filter((candidate) =>
              normalizedEpoch(candidate.capturedAt) >= navigationStartedAt &&
              normalizedEpoch(candidate.navigationStartedAt, navigationStartedAt) === navigationStartedAt,
            );
        sendResponse({ ok: true, navigationStartedAt, candidates });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "CLEAR_MEDIA_CANDIDATES") {
    clearCandidates(message.tabId, message.navigationStartedAt)
      .then(({ navigationStartedAt }) =>
        sendResponse({ ok: true, navigationStartedAt }),
      )
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
