// EasyEDA public-API transport: one request at a time, paced, full desktop UA, exponential backoff.
// The site sits behind CloudFront with a per-IP rate limit: bursts answer 403 with a 919-byte HTML
// page, a truncated User-Agent answers 403 too. See _probe/spec.md §1 "Transport notes".

const BASE = "https://easyeda.com";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";
const MIN_GAP_MS = 1500;

let lastRequestAt = 0;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(base, attempt) {
  return Math.min(base * 2 ** (attempt - 1), 20000);
}

function snippet(body) {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 120 ? flat.slice(0, 120) + "…" : flat;
}

async function once(url, timeoutMs) {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: BASE + "/",
    },
  });
  return { status: response.status, body: await response.text() };
}

async function fetchWithRetry(url, { tries, baseDelayMs, timeoutMs }) {
  let last = "no attempt";
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    let response;
    try {
      response = await once(url, timeoutMs);
    } catch (error) {
      last = `network error: ${error?.message || error}`;
      if (attempt < tries) await sleep(backoffMs(baseDelayMs, attempt));
      continue;
    }
    const { status, body } = response;
    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(body);
      } catch {
        last = `HTTP ${status} with a non-JSON body (${Buffer.byteLength(body)} bytes): ${snippet(body)}`;
      }
    } else if (status === 403 || status === 408 || status === 425 || status === 429 || status >= 500) {
      last = `HTTP ${status}: ${snippet(body)}`;
    } else {
      throw new Error(`easyeda GET ${url} failed: HTTP ${status} (${snippet(body)})`);
    }
    if (attempt < tries) await sleep(backoffMs(baseDelayMs, attempt));
  }
  throw new Error(`easyeda GET ${url} failed after ${tries} tries: ${last}`);
}

/**
 * GET an easyeda.com JSON endpoint. Calls are serialised: retries included, never two in flight.
 * @param {string} pathOrUrl absolute URL or a path starting with "/"
 * @param {{tries?: number, baseDelayMs?: number, timeoutMs?: number}} [options]
 */
export function getJson(pathOrUrl, options = {}) {
  const url = String(pathOrUrl).startsWith("http") ? String(pathOrUrl) : BASE + pathOrUrl;
  const opts = { tries: 5, baseDelayMs: 2000, timeoutMs: 60000, ...options };
  const task = () => fetchWithRetry(url, opts);
  const settled = queue.then(task, task);
  queue = settled.then(
    () => undefined,
    () => undefined,
  );
  return settled;
}
