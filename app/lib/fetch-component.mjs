// A 数据层: easyeda.com public API -> CONTRACT.md §1 ComponentModel (see CONTRACT.md §2).
// Zero dependencies (Node built-in fetch), pure ESM, one request at a time.

import { getJson, UA } from "./easyeda/http.mjs";
import { buildComponentModel, mapSearchResults } from "./easyeda/parse.mjs";

const LCSC_RE = /^C\d+$/;
const LCSC_ITEM_RE = /^https?:\/\/item\.szlcsc\.com\//i;

// Some official parts have no EasyEDA `result.description` (C92116). The LCSC
// product page still has the parameter table that Altium's own library
// description is built from; use it only as a fallback.
function extractParamList(html) {
  const marker = '"paramList":';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const open = html.indexOf("[", at + marker.length);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(html.slice(open, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

async function lcscParamDescription(rawResult) {
  const link = String(
    rawResult?.packageDetail?.dataStr?.head?.c_para?.link ||
    rawResult?.dataStr?.head?.c_para?.link || ""
  ).trim();
  if (!LCSC_ITEM_RE.test(link)) return "";
  try {
    const response = await fetch(link, {
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) return "";
    const list = extractParamList(await response.text());
    if (!Array.isArray(list)) return "";
    let text = "";
    for (const item of list) {
      const name = String(item?.parameterName || "").trim();
      const value = String(item?.parameterDetailValue || item?.parameterValue || "").trim();
      if (!name || !value || value === "-" || value === "—") continue;
      const piece = name + ":" + value;
      if (text && (text + ";" + piece).length > 400) break;
      text = text ? text + ";" + piece : piece;
    }
    return text ? text + ";" : "";
  } catch {
    return "";
  }
}

function requireQuery(value, fnName) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${fnName}: query must be a non-empty string`);
  return text;
}

function asLcsc(value, fnName) {
  const text = requireQuery(value, fnName).toUpperCase().replace(/\s+/g, "");
  if (!LCSC_RE.test(text)) {
    throw new Error(`${fnName}: "${value}" is not an LCSC C-number (expected e.g. C25804)`);
  }
  return text;
}

// getJson only ever returns the parsed body of a 2xx answer, so the HTTP status here is always 200;
// the API reports its own failure code inside the envelope.
const HTTP_OK = "HTTP 200";

function apiFailure(raw, what) {
  if (raw && typeof raw === "object" && raw.success === false) {
    const code = raw.code ?? raw.status ?? "?";
    const message = raw.message ?? raw.msg ?? "no message";
    return new Error(`easyeda api error for ${what}: code=${code} (${HTTP_OK}) "${message}"`);
  }
  return new Error(`easyeda api returned no result for ${what} (${HTTP_OK})`);
}

/**
 * @param {string} query LCSC number, MPN or any keyword
 * @param {{limit?: number}} [options]
 * @returns {Promise<Array<{lcsc: string, mpn: string, manufacturer: string, package: string, description: string, stock: number, price: number}>>}
 */
export async function searchComponents(query, { limit = 20 } = {}) {
  const keyword = requireQuery(query, "searchComponents");
  const raw = await getJson(`/api/eda/product/search?keyword=${encodeURIComponent(keyword)}`);
  if (!raw || typeof raw !== "object" || !raw.result) throw apiFailure(raw, `search "${keyword}"`);
  return mapSearchResults(raw, limit);
}

/**
 * Resolve a C-number or a name to one chosen candidate plus the full candidate list.
 * @param {string} query
 * @returns {Promise<{chosen: object, candidates: object[]}>}
 */
export async function resolveComponent(query) {
  const keyword = requireQuery(query, "resolveComponent");
  const compact = keyword.toUpperCase().replace(/\s+/g, "");
  if (LCSC_RE.test(compact)) {
    // Direct C-number: enrich with search metadata when the search endpoint answers, but never let
    // that (rate-limited) extra lookup break the direct path.
    let candidates = [];
    try {
      candidates = await searchComponents(compact);
    } catch {
      candidates = [];
    }
    const exact = candidates.find((candidate) => candidate.lcsc.toUpperCase() === compact);
    if (exact) return { chosen: exact, candidates };
    const minimal = { lcsc: compact, mpn: "", manufacturer: "", package: "", description: "", stock: 0, price: 0 };
    return { chosen: minimal, candidates: [minimal] };
  }
  const candidates = await searchComponents(keyword);
  if (candidates.length === 0) {
    throw new Error(`resolveComponent("${keyword}"): easyeda search returned no LCSC candidate`);
  }
  return { chosen: candidates[0], candidates };
}

/**
 * @param {string} lcsc e.g. "C25804"
 * @returns {Promise<object>} CONTRACT §1 ComponentModel
 */
export async function fetchComponentModel(lcsc) {
  const id = asLcsc(lcsc, "fetchComponentModel");
  const raw = await getJson(`/api/products/${encodeURIComponent(id)}/components`);
  if (!raw || typeof raw !== "object" || raw.success === false || !raw.result) {
    throw apiFailure(raw, id);
  }
  try {
    const model = buildComponentModel(raw, id);
    if (!model.description) {
      const fallback = await lcscParamDescription(raw.result);
      if (fallback) model.description = fallback;
    }
    return model;
  } catch (error) {
    throw new Error(`fetchComponentModel(${id}): ${error?.message || error}`);
  }
}
