import { log } from "./index";
import * as cheerio from "cheerio";
import type { IStorage } from "./storage";
import OpenAI from "openai";

export interface MatchScore {
  total: number;
  slugScore: number;
  titleScore: number;
  structureScore: number;
  method: "slug" | "meta" | "structure" | "mixed" | "pattern";
}

export type TargetLang = "en" | "fr" | "ru" | "ar";

export interface TabPatterns {
  enRoot: string[];
  frRoot: string[];
  ruRoot: string[];
  arRoot: string[];
  enSrcRoot: string[];
  frSrcRoot: string[];
  ruSrcRoot: string[];
  arSrcRoot: string[];
  enCrawlScope: string[];
  frCrawlScope: string[];
  ruCrawlScope: string[];
  arCrawlScope: string[];
  segmentMap: Map<string, Map<string, string>>;
  rootMappings: Map<string, Array<{ sourceRoot: string[]; targetRoot: string[] }>>;
  patternValidated: { en: boolean; fr: boolean; ru: boolean; ar: boolean };
  langSuffixRule: Record<TargetLang, { prefix: string[]; suffix: string; depth: number } | null>;
}

export function langSuffixRuleFor(tp: TabPatterns, lang: TargetLang): { prefix: string[]; suffix: string; depth: number } | null {
  return tp.langSuffixRule?.[lang] ?? null;
}

function decodeLowerSegment(seg: string): string {
  try { return decodeURIComponent(seg).toLowerCase().trim(); }
  catch { return seg.toLowerCase().trim(); }
}

const SUFFIX_RE = /^(.+?)([_-][a-z]{1,3})$/;

function detectLangSuffixRule(
  pairs: { src: string[]; tgt: string[] }[]
): { prefix: string[]; suffix: string; depth: number } | null {
  if (pairs.length < 1) return null;

  type Obs = { prefix: string[]; suffix: string; depth: number };
  const perPairBest: (Obs | null)[] = [];

  for (const { src, tgt } of pairs) {
    if (src.length === 0 || tgt.length === 0) { perPairBest.push(null); continue; }
    const extra = tgt.length - src.length;
    if (extra < 0 || extra > 2) { perPairBest.push(null); continue; }
    const prefix = tgt.slice(0, Math.max(0, extra));
    const aligned = tgt.slice(Math.max(0, extra));
    if (aligned.length !== src.length) { perPairBest.push(null); continue; }

    const observations: Obs[] = [];
    for (let i = 0; i < aligned.length; i++) {
      const tRaw = decodeLowerSegment(aligned[i]);
      const m = tRaw.match(SUFFIX_RE);
      if (!m) continue;
      const sRaw = decodeLowerSegment(src[i]);
      if (sRaw.endsWith(m[2])) continue;
      observations.push({ prefix, suffix: m[2], depth: i });
    }
    if (observations.length === 0) { perPairBest.push(null); continue; }
    observations.sort((a, b) => a.depth - b.depth);
    perPairBest.push(observations[0]);
  }

  const valid = perPairBest.filter((o): o is Obs => o !== null);
  if (valid.length === 0) return null;

  const key = (c: Obs) =>
    c.prefix.map(p => decodeLowerSegment(p)).join("/") + "|" + c.suffix + "|" + c.depth;
  const counts = new Map<string, { rule: Obs; count: number }>();
  for (const o of valid) {
    const k = key(o);
    if (!counts.has(k)) counts.set(k, { rule: o, count: 0 });
    counts.get(k)!.count++;
  }

  const sorted = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  const top = sorted[0];
  const second = sorted[1];
  const totalPairs = pairs.length;
  if (top.count < 2 && totalPairs >= 2) return null;
  if (totalPairs === 1 && top.count < 1) return null;
  if (second && second.count >= top.count) return null;
  if (top.count / totalPairs < 0.6) return null;
  return top.rule;
}

export function langRoot(tp: TabPatterns, lang: TargetLang): string[] {
  return { en: tp.enRoot, fr: tp.frRoot, ru: tp.ruRoot, ar: tp.arRoot }[lang];
}
export function langSrcRoot(tp: TabPatterns, lang: TargetLang): string[] {
  return { en: tp.enSrcRoot, fr: tp.frSrcRoot, ru: tp.ruSrcRoot, ar: tp.arSrcRoot }[lang];
}
export function langCrawlScope(tp: TabPatterns, lang: TargetLang): string[] {
  return { en: tp.enCrawlScope, fr: tp.frCrawlScope, ru: tp.ruCrawlScope, ar: tp.arCrawlScope }[lang];
}

export interface VerifyResult {
  ok: boolean;
  finalUrl: string;
}

const urlExistenceCache = new Map<string, VerifyResult>();
const translationCache = new Map<string, string>();
const HEAD_CONCURRENCY = 10;
const HEAD_TIMEOUT = 12000;
const HEAD_BATCH_DELAY = 200;
let lastHeadGetRescues = 0;
let lastHeadGetAttempts = 0;
let lastRedirectAttempts = 0;
let lastRedirectRescues = 0;
export function consumeHeadGetRescueStats(): { attempts: number; rescues: number } {
  const v = { attempts: lastHeadGetAttempts, rescues: lastHeadGetRescues };
  lastHeadGetAttempts = 0;
  lastHeadGetRescues = 0;
  return v;
}
export function consumeRedirectRescueStats(): { attempts: number; rescues: number } {
  const v = { attempts: lastRedirectAttempts, rescues: lastRedirectRescues };
  lastRedirectAttempts = 0;
  lastRedirectRescues = 0;
  return v;
}

function isSafeFinalUrl(originalUrl: string, finalUrl: string): boolean {
  try {
    const a = new URL(originalUrl);
    const b = new URL(finalUrl);
    if (a.origin !== b.origin) return false;
    if (!b.pathname || b.pathname === "/" || b.pathname === "") return false;
    return true;
  } catch {
    return false;
  }
}

function pagesDefaultVariant(url: string): string | null {
  try {
    const u = new URL(url);
    const p = u.pathname;
    if (p.toLowerCase().endsWith("/pages/default.aspx")) return null;
    if (p.toLowerCase().endsWith(".aspx")) return null;
    if (p.endsWith("/")) {
      return u.origin + p + "Pages/default.aspx" + u.search;
    }
    const last = p.split("/").pop() || "";
    if (!last.includes(".")) {
      return u.origin + p + "/Pages/default.aspx" + u.search;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearCaches() {
  urlExistenceCache.clear();
}

export function clearAllCaches() {
  urlExistenceCache.clear();
  translationCache.clear();
}

function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    let onAbort: (() => void) | null = null;
    if (signal) {
      onAbort = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener("abort", onAbort);
    }
  });
}

function combineSignals(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let onAbort: (() => void) | null = null;
  if (parent) {
    if (parent.aborted) controller.abort();
    else {
      onAbort = () => controller.abort();
      parent.addEventListener("abort", onAbort);
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (parent && onAbort) parent.removeEventListener("abort", onAbort);
    },
  };
}

function parseHttpUrl(url: string): URL | null {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function buildVerificationHeaders(parsed: URL, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...BROWSER_HEADERS, ...(extra ?? {}) };
  if (parsed.origin && parsed.origin !== "null") {
    headers["Referer"] = parsed.origin + "/";
  }
  return headers;
}

async function getCheck(url: string, signal?: AbortSignal): Promise<VerifyResult> {
  if (signal?.aborted) return { ok: false, finalUrl: url };
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    console.warn(`[scraper] skipped: invalid URL (${url})`);
    return { ok: false, finalUrl: url };
  }
  const { signal: combined, cleanup } = combineSignals(signal, HEAD_TIMEOUT);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: combined,
      headers: buildVerificationHeaders(parsed, { "Range": "bytes=0-2047" }),
      redirect: "follow",
    });
    try { (response.body as any)?.cancel?.(); } catch {}
    cleanup();
    return { ok: response.ok || response.status === 206, finalUrl: response.url || url };
  } catch {
    cleanup();
    return { ok: false, finalUrl: url };
  }
}

async function probeOnce(url: string, signal?: AbortSignal): Promise<VerifyResult> {
  if (signal?.aborted) return { ok: false, finalUrl: url };
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    console.warn(`[scraper] skipped: invalid URL (${url})`);
    return { ok: false, finalUrl: url };
  }
  const { signal: combined, cleanup } = combineSignals(signal, HEAD_TIMEOUT);
  let headResult: VerifyResult | null = null;
  let headFailed = false;
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: combined,
      headers: buildVerificationHeaders(parsed),
      redirect: "follow",
    });
    cleanup();
    headResult = { ok: response.ok, finalUrl: response.url || url };
    if (!response.ok) headFailed = true;
  } catch {
    cleanup();
    if (signal?.aborted) return { ok: false, finalUrl: url };
    headFailed = true;
  }

  if (headResult && headResult.ok) return headResult;

  if (headFailed) {
    lastHeadGetAttempts++;
    const getResult = await getCheck(url, signal);
    if (getResult.ok) {
      lastHeadGetRescues++;
      return getResult;
    }
    if (headResult) return headResult;
    return getResult;
  }

  return headResult ?? { ok: false, finalUrl: url };
}

async function headCheck(url: string, signal?: AbortSignal): Promise<VerifyResult> {
  const cached = urlExistenceCache.get(url);
  if (cached) return cached;
  if (signal?.aborted) return { ok: false, finalUrl: url };

  let result = await probeOnce(url, signal);

  const redirected = result.finalUrl !== url;
  if (redirected) lastRedirectAttempts++;

  // If a redirect chain ended at a non-OK directory-style URL, try the
  // /Pages/default.aspx variant of that final URL (mirrors the standard
  // page-shape retry treatment we apply to original candidates).
  if (!result.ok && redirected && isSafeFinalUrl(url, result.finalUrl)) {
    const variant = pagesDefaultVariant(result.finalUrl);
    if (variant) {
      const variantResult = await probeOnce(variant, signal);
      if (variantResult.ok && isSafeFinalUrl(url, variantResult.finalUrl)) {
        result = variantResult;
      }
    }
  }

  if (result.ok) {
    if (result.finalUrl !== url) {
      if (isSafeFinalUrl(url, result.finalUrl)) {
        lastRedirectRescues++;
      } else {
        // Refuse to record an off-origin or root redirect target.
        result = { ok: result.ok, finalUrl: url };
      }
    }
  } else {
    result = { ok: false, finalUrl: url };
  }

  urlExistenceCache.set(url, result);
  return result;
}

export async function batchHeadCheck(urls: string[], signal?: AbortSignal): Promise<Map<string, VerifyResult>> {
  const results = new Map<string, VerifyResult>();
  const uncached: string[] = [];
  for (const url of urls) {
    const cached = urlExistenceCache.get(url);
    if (cached) {
      results.set(url, cached);
    } else {
      uncached.push(url);
    }
  }
  const beforeAttempts = lastHeadGetAttempts;
  const beforeRescues = lastHeadGetRescues;
  const beforeRedirAttempts = lastRedirectAttempts;
  const beforeRedirRescues = lastRedirectRescues;
  for (let i = 0; i < uncached.length; i += HEAD_CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = uncached.slice(i, i + HEAD_CONCURRENCY);
    const checks = await Promise.all(
      batch.map(async (url) => ({ url, result: await headCheck(url, signal) }))
    );
    for (const { url, result } of checks) {
      results.set(url, result);
    }
    if (i + HEAD_CONCURRENCY < uncached.length) {
      await new Promise(resolve => setTimeout(resolve, HEAD_BATCH_DELAY));
    }
  }
  const getAttempts = lastHeadGetAttempts - beforeAttempts;
  const getRescues = lastHeadGetRescues - beforeRescues;
  if (uncached.length > 0 && getAttempts > 0) {
    log(`    HEAD→GET fallback: ${getRescues}/${getAttempts} URLs rescued by GET (out of ${uncached.length} checked)`);
  }
  const redirAttempts = lastRedirectAttempts - beforeRedirAttempts;
  const redirRescues = lastRedirectRescues - beforeRedirRescues;
  if (uncached.length > 0 && redirAttempts > 0) {
    log(`    Redirect rescues: ${redirRescues}/${redirAttempts} URLs followed to a verified final URL (out of ${uncached.length} checked)`);
  }
  return results;
}

export interface RootMapping {
  sourceRoot: string[];
  targetRoot: string[];
}

export function learnTabPatterns(
  rows: { sourceUrl: string; enUrl?: string; frUrl?: string; ruUrl?: string; arUrl?: string }[],
  activeLangs?: TargetLang[],
  opts?: { silent?: boolean; label?: string }
): TabPatterns {
  const silent = !!opts?.silent;
  const labelPrefix = opts?.label ? `${opts.label} ` : "";
  const segmentMap = new Map<string, Map<string, string>>();
  const allLangs: TargetLang[] = ["en", "fr", "ru", "ar"];
  const langs: TargetLang[] = activeLangs && activeLangs.length > 0
    ? allLangs.filter(l => activeLangs.includes(l))
    : allLangs;
  for (const l of langs) segmentMap.set(l, new Map());

  const pairsByLang: Record<string, { src: string[]; tgt: string[] }[]> = { en: [], fr: [], ru: [], ar: [] };

  for (const row of rows) {
    try {
      const sourceParsed = new URL(row.sourceUrl);
      const sourceParts = sourceParsed.pathname.split("/").filter(Boolean);
      if (sourceParts.length === 0) continue;

      const langUrls: [TargetLang, string | undefined][] = [["en", row.enUrl], ["fr", row.frUrl], ["ru", row.ruUrl], ["ar", row.arUrl]];
      for (const [lang, url] of langUrls) {
        if (!langs.includes(lang)) continue;
        if (url) {
          try {
            const parsed = new URL(url);
            if (parsed.origin === sourceParsed.origin) {
              const parts = parsed.pathname.split("/").filter(Boolean);
              pairsByLang[lang].push({ src: stripSuffix(sourceParts), tgt: stripSuffix(parts) });
            }
          } catch {}
        }
      }
    } catch {}
  }

  const mappings: Record<string, ReturnType<typeof computeRootMapping>> = {};
  for (const l of langs) {
    mappings[l] = computeRootMapping(pairsByLang[l], segmentMap.get(l)!);
  }

  const root = (l: string) => mappings[l] ? mappings[l]!.common.targetRoot : [];
  const srcRoot = (l: string) => mappings[l] ? mappings[l]!.common.sourceRoot : [];

  const enRoot = root("en"), frRoot = root("fr"), ruRoot = root("ru"), arRoot = root("ar");
  const enSrcRoot = srcRoot("en"), frSrcRoot = srcRoot("fr"), ruSrcRoot = srcRoot("ru"), arSrcRoot = srcRoot("ar");

  const rootMappings = new Map<string, Array<{ sourceRoot: string[]; targetRoot: string[] }>>();
  for (const l of langs) {
    rootMappings.set(l, mappings[l] ? mappings[l]!.perPair : []);
  }

  const langSuffixRule: Record<TargetLang, { prefix: string[]; suffix: string; depth: number } | null> = { en: null, fr: null, ru: null, ar: null };
  for (const l of langs) {
    langSuffixRule[l] = detectLangSuffixRule(pairsByLang[l]);
    if (langSuffixRule[l] && !silent) {
      const r = langSuffixRule[l]!;
      log(`  ${labelPrefix}${l.toUpperCase()} suffix rule detected: prefix=/${r.prefix.join("/")}/, suffix=${r.suffix}, depth=${r.depth}`);
    }
  }

  function computeCrawlScope(lang: string): string[] {
    const pairs = pairsByLang[lang];
    const r = root(lang);
    let scope = pairs.length > 0 ? findCommonPrefix(pairs.map((p) => p.tgt)) : r;
    if (scope.length > 0 && normalizeSegment(scope[scope.length - 1]) === "pages") {
      scope = scope.slice(0, -1);
    }
    return scope;
  }

  const enCrawlScope = computeCrawlScope("en");
  const frCrawlScope = computeCrawlScope("fr");
  const ruCrawlScope = computeCrawlScope("ru");
  const arCrawlScope = computeCrawlScope("ar");

  if (!silent) {
    log(`${labelPrefix}Tab patterns learned:`);
    for (const l of langs) {
      const label = l.toUpperCase();
      if (mappings[l]) log(`  ${label}: /${srcRoot(l).join("/") || "*"}/ → /${root(l).join("/")}/`);
      const cs = { en: enCrawlScope, fr: frCrawlScope, ru: ruCrawlScope, ar: arCrawlScope }[l];
      if (cs.length > root(l).length) log(`  ${label} crawl scope: /${cs.join("/")}/`);
      const pairCount = rootMappings.get(l)?.length || 0;
      if (pairCount > 1) log(`  ${label} per-pair root mappings: ${pairCount} unique`);
    }
    const segCounts = langs.map(l => `${segmentMap.get(l)?.size || 0} ${l.toUpperCase()}`).join(", ");
    log(`  Segment translations: ${segCounts}`);
  }

  return {
    enRoot, frRoot, ruRoot, arRoot,
    enSrcRoot, frSrcRoot, ruSrcRoot, arSrcRoot,
    enCrawlScope, frCrawlScope, ruCrawlScope, arCrawlScope,
    segmentMap,
    rootMappings,
    patternValidated: { en: false, fr: false, ru: false, ar: false },
    langSuffixRule,
  };
}

/**
 * Merge a job-wide "global" pattern registry into a per-tab TabPatterns.
 * Per-tab patterns win on conflicts (segment translations and per-pair root
 * mappings the tab already learned are preserved). Global entries fill in
 * gaps so a tab benefits from training pairs that live in other tabs.
 *
 * Returns counts so callers can log how much the merge contributed.
 */
export function mergeIntoTabPatterns(
  tab: TabPatterns,
  global: TabPatterns,
  activeLangs?: TargetLang[],
): { addedSegments: Record<TargetLang, number>; addedPairs: Record<TargetLang, number> } {
  const allLangs: TargetLang[] = ["en", "fr", "ru", "ar"];
  const langs: TargetLang[] = activeLangs && activeLangs.length > 0
    ? allLangs.filter(l => activeLangs.includes(l))
    : allLangs;

  const addedSegments: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  const addedPairs: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };

  const rootKeys: Record<TargetLang, "enRoot" | "frRoot" | "ruRoot" | "arRoot"> =
    { en: "enRoot", fr: "frRoot", ru: "ruRoot", ar: "arRoot" };
  const srcRootKeys: Record<TargetLang, "enSrcRoot" | "frSrcRoot" | "ruSrcRoot" | "arSrcRoot"> =
    { en: "enSrcRoot", fr: "frSrcRoot", ru: "ruSrcRoot", ar: "arSrcRoot" };
  const scopeKeys: Record<TargetLang, "enCrawlScope" | "frCrawlScope" | "ruCrawlScope" | "arCrawlScope"> =
    { en: "enCrawlScope", fr: "frCrawlScope", ru: "ruCrawlScope", ar: "arCrawlScope" };

  for (const l of langs) {
    if (tab[rootKeys[l]].length === 0 && global[rootKeys[l]].length > 0) {
      tab[rootKeys[l]] = global[rootKeys[l]].slice();
    }
    if (tab[srcRootKeys[l]].length === 0 && global[srcRootKeys[l]].length > 0) {
      tab[srcRootKeys[l]] = global[srcRootKeys[l]].slice();
    }
    if (tab[scopeKeys[l]].length === 0 && global[scopeKeys[l]].length > 0) {
      tab[scopeKeys[l]] = global[scopeKeys[l]].slice();
    }
    if (!tab.langSuffixRule[l] && global.langSuffixRule[l]) {
      tab.langSuffixRule[l] = global.langSuffixRule[l];
    }

    if (!tab.segmentMap.has(l)) tab.segmentMap.set(l, new Map());
    const tabSeg = tab.segmentMap.get(l)!;
    const globalSeg = global.segmentMap.get(l);
    if (globalSeg) {
      for (const [k, v] of globalSeg.entries()) {
        if (!tabSeg.has(k)) {
          tabSeg.set(k, v);
          addedSegments[l]++;
        }
      }
    }

    if (!tab.rootMappings.has(l)) tab.rootMappings.set(l, []);
    const tabPairs = tab.rootMappings.get(l)!;
    const tabKeys = new Set(tabPairs.map(p =>
      p.sourceRoot.map(s => normalizeSegment(s)).join("/") + "||" +
      p.targetRoot.map(s => normalizeSegment(s)).join("/")
    ));
    const globalPairs = global.rootMappings.get(l) || [];
    for (const gp of globalPairs) {
      const key = gp.sourceRoot.map(s => normalizeSegment(s)).join("/") + "||" +
                  gp.targetRoot.map(s => normalizeSegment(s)).join("/");
      if (!tabKeys.has(key)) {
        tabPairs.push({ sourceRoot: gp.sourceRoot.slice(), targetRoot: gp.targetRoot.slice() });
        tabKeys.add(key);
        addedPairs[l]++;
      }
    }
  }

  return { addedSegments, addedPairs };
}

/** Top-N segment translation samples per language for diagnostic logging. */
export function summarizeSegmentTranslations(
  tp: TabPatterns,
  activeLangs: TargetLang[],
  topN: number = 12,
): string[] {
  const lines: string[] = [];
  for (const l of activeLangs) {
    const seg = tp.segmentMap.get(l);
    if (!seg || seg.size === 0) continue;
    const entries = Array.from(seg.entries()).slice(0, topN);
    const sample = entries.map(([k, v]) => `${k}→${v}`).join(", ");
    const more = seg.size > topN ? `, +${seg.size - topN} more` : "";
    lines.push(`  ${l.toUpperCase()} (${seg.size}): ${sample}${more}`);
  }
  return lines;
}

function normalizeSegment(seg: string): string {
  return decodeURIComponent(seg).toLowerCase().replace(/[_\s]+/g, " ").trim();
}

function stripSuffix(parts: string[]): string[] {
  const last = parts[parts.length - 1];
  if (last && normalizeSegment(last) === "default.aspx") {
    return parts.slice(0, -1);
  }
  return parts;
}

function computeRootMapping(
  pairs: { src: string[]; tgt: string[] }[],
  segMap: Map<string, string>
): { common: RootMapping; perPair: Array<{ sourceRoot: string[]; targetRoot: string[] }> } | null {
  if (pairs.length === 0) return null;

  const srcRoots: string[][] = [];
  const tgtRoots: string[][] = [];
  const pairRoots: Array<{ sourceRoot: string[]; targetRoot: string[] }> = [];

  for (const pair of pairs) {
    const { src, tgt } = pair;

    let tailMatches = 0;
    const minLen = Math.min(src.length, tgt.length);
    for (let i = 0; i < minLen; i++) {
      const sNorm = normalizeSegment(src[src.length - 1 - i]);
      const tNorm = normalizeSegment(tgt[tgt.length - 1 - i]);
      if (sNorm === tNorm) {
        tailMatches++;
      } else {
        break;
      }
    }

    const srcRootLen = src.length - tailMatches;
    const tgtRootLen = tgt.length - tailMatches;

    const pairSrcRoot = src.slice(0, srcRootLen);
    const pairTgtRoot = tgt.slice(0, tgtRootLen);

    srcRoots.push(pairSrcRoot);
    tgtRoots.push(pairTgtRoot);
    pairRoots.push({ sourceRoot: pairSrcRoot, targetRoot: pairTgtRoot });

    const minRootLen = Math.min(srcRootLen, tgtRootLen);
    for (let i = 0; i < minRootLen; i++) {
      const sIdx = srcRootLen - 1 - i;
      const tIdx = tgtRootLen - 1 - i;
      const sNorm = normalizeSegment(src[sIdx]);
      const tNorm = normalizeSegment(tgt[tIdx]);
      if (sNorm !== tNorm) {
        segMap.set(sNorm, tgt[tIdx]);
      }
    }

    for (let i = 0; i < tailMatches; i++) {
      const sIdx = src.length - tailMatches + i;
      const tIdx = tgt.length - tailMatches + i;
      if (sIdx < src.length && tIdx < tgt.length) {
        const sNorm = normalizeSegment(src[sIdx]);
        const tOrig = tgt[tIdx];
        if (src[sIdx] !== tOrig) {
          segMap.set(sNorm, tOrig);
        }
      }
    }
  }

  const commonSrcRoot = findCommonPrefix(srcRoots);
  const commonTgtRoot = findCommonPrefix(tgtRoots);

  if (commonTgtRoot.length === 0 && commonSrcRoot.length === 0) return null;

  const seen = new Set<string>();
  const uniquePairRoots: Array<{ sourceRoot: string[]; targetRoot: string[] }> = [];
  for (const pr of pairRoots) {
    const key = pr.sourceRoot.map(s => normalizeSegment(s)).join("/") + "||" + pr.targetRoot.map(s => normalizeSegment(s)).join("/");
    if (!seen.has(key)) {
      seen.add(key);
      uniquePairRoots.push(pr);
    }
  }

  const commonSrcNorms = new Set(commonSrcRoot.map(s => normalizeSegment(s)));
  const keysToRemove: string[] = [];
  for (const [key, value] of segMap.entries()) {
    if (commonSrcNorms.has(key)) {
      const valueNorm = normalizeSegment(value);
      const isInCommonTarget = commonTgtRoot.some(s => normalizeSegment(s) === valueNorm);
      if (!isInCommonTarget) {
        keysToRemove.push(key);
      }
    }
  }
  for (const key of keysToRemove) {
    segMap.delete(key);
  }

  return {
    common: { sourceRoot: commonSrcRoot, targetRoot: commonTgtRoot },
    perPair: uniquePairRoots,
  };
}

function findCommonPrefix(arrays: string[][]): string[] {
  if (arrays.length === 0) return [];
  if (arrays.length === 1) return arrays[0].slice();

  const prefix: string[] = [];
  const minLen = Math.min(...arrays.map((a) => a.length));

  for (let i = 0; i < minLen; i++) {
    const first = normalizeSegment(arrays[0][i]);
    const allSame = arrays.every((arr) => normalizeSegment(arr[i]) === first);
    if (allSame) {
      prefix.push(arrays[0][i]);
    } else {
      break;
    }
  }
  return prefix;
}

export function constructTargetUrl(
  sourceUrl: string,
  lang: TargetLang,
  tabPatterns: TabPatterns
): { translated: string | null; untranslated: string | null } {
  try {
    const parsed = new URL(sourceUrl);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length === 0) return { translated: null, untranslated: null };

    const commonTargetRoot = langRoot(tabPatterns, lang);
    const commonSourceRoot = langSrcRoot(tabPatterns, lang);
    if (commonTargetRoot.length === 0) return { translated: null, untranslated: null };

    const segments = tabPatterns.segmentMap.get(lang);
    const cleanParts = stripSuffix(pathParts);

    let targetRoot = commonTargetRoot;
    let remaining: string[];

    const pairMappings = tabPatterns.rootMappings.get(lang) || [];
    let bestMapping: { sourceRoot: string[]; targetRoot: string[] } | null = null;
    let bestMatchLen = 0;

    for (const mapping of pairMappings) {
      if (mapping.sourceRoot.length <= bestMatchLen) continue;
      let matchLen = 0;
      for (let i = 0; i < mapping.sourceRoot.length && i < cleanParts.length; i++) {
        if (normalizeSegment(cleanParts[i]) === normalizeSegment(mapping.sourceRoot[i])) {
          matchLen++;
        } else {
          break;
        }
      }
      if (matchLen === mapping.sourceRoot.length && matchLen > bestMatchLen) {
        bestMapping = mapping;
        bestMatchLen = matchLen;
      }
    }

    const usedPerPair = !!bestMapping;
    if (usedPerPair) {
      targetRoot = bestMapping!.targetRoot;
      remaining = cleanParts.slice(bestMatchLen);
      if (targetRoot.length > 0 && targetRoot[targetRoot.length - 1].toLowerCase().endsWith(".aspx") && remaining.length > 0) {
        targetRoot = targetRoot.slice(0, -1);
      }
      while (remaining.length > 0 && targetRoot.length > 0 &&
        normalizeSegment(remaining[0]) === normalizeSegment(targetRoot[targetRoot.length - 1])) {
        remaining = remaining.slice(1);
      }
    } else if (commonSourceRoot.length > 0) {
      let matchLen = 0;
      for (let i = 0; i < commonSourceRoot.length && i < cleanParts.length; i++) {
        if (normalizeSegment(cleanParts[i]) === normalizeSegment(commonSourceRoot[i])) {
          matchLen++;
        } else {
          break;
        }
      }
      remaining = cleanParts.slice(matchLen);
    } else {
      remaining = cleanParts;
    }

    let untranslated = parsed.origin + "/" + [...targetRoot, ...remaining].join("/");

    const translatedParts = remaining.map((part) => {
      if (!segments) return part;
      const norm = normalizeSegment(part);
      return segments.has(norm) ? segments.get(norm)! : part;
    });

    let translated = parsed.origin + "/" + [...targetRoot, ...translatedParts].join("/");

    const suffixRule = langSuffixRuleFor(tabPatterns, lang);
    if (
      suffixRule &&
      !usedPerPair &&
      cleanParts.length > suffixRule.depth &&
      !cleanParts[suffixRule.depth].toLowerCase().endsWith(suffixRule.suffix.toLowerCase())
    ) {
      const transformed = cleanParts.map((p, i) => i === suffixRule.depth ? p + suffixRule.suffix : p);
      untranslated = parsed.origin + "/" + [...suffixRule.prefix, ...transformed].join("/");
      const tParts = transformed.map((part, i) => {
        if (i === suffixRule.depth) {
          if (segments) {
            const baseNorm = normalizeSegment(cleanParts[i]);
            if (segments.has(baseNorm)) return segments.get(baseNorm)! + suffixRule.suffix;
          }
          return part;
        }
        if (!segments) return part;
        const norm = normalizeSegment(part);
        return segments.has(norm) ? segments.get(norm)! : part;
      });
      translated = parsed.origin + "/" + [...suffixRule.prefix, ...tParts].join("/");
    }

    if (suffixRule) {
      const suffixed = appendFilenameSuffix(untranslated, suffixRule.suffix);
      if (suffixed) untranslated = suffixed;
      const tSuffixed = appendFilenameSuffix(translated, suffixRule.suffix);
      if (tSuffixed) translated = tSuffixed;
    }

    return {
      translated: translated !== untranslated ? translated : null,
      untranslated,
    };
  } catch {}

  return { translated: null, untranslated: null };
}

const FILENAME_EXT_RE = /^(.+)\.(aspx|html?|ashx)$/i;

function appendFilenameSuffix(url: string, suffix: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const last = parts[parts.length - 1];
    const m = last.match(FILENAME_EXT_RE);
    if (!m) return null;
    const stem = m[1];
    const ext = m[2];
    if (stem.toLowerCase().endsWith(suffix.toLowerCase())) return null;
    parts[parts.length - 1] = `${stem}${suffix}.${ext}`;
    return u.origin + "/" + parts.join("/");
  } catch {
    return null;
  }
}

export function constructAllTargetUrls(
  sourceUrl: string,
  lang: TargetLang,
  tabPatterns: TabPatterns
): string[] {
  const candidates = new Set<string>();
  try {
    const parsed = new URL(sourceUrl);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length === 0) return [];

    const commonTargetRoot = langRoot(tabPatterns, lang);
    const commonSourceRoot = langSrcRoot(tabPatterns, lang);
    if (commonTargetRoot.length === 0) return [];

    const segments = tabPatterns.segmentMap.get(lang);
    const cleanParts = stripSuffix(pathParts);

    const buildUrl = (tgtRoot: string[], rem: string[]) => {
      let tr = tgtRoot;
      let r = rem;
      if (tr.length > 0 && tr[tr.length - 1].toLowerCase().endsWith(".aspx") && r.length > 0) {
        tr = tr.slice(0, -1);
      }
      while (r.length > 0 && tr.length > 0 &&
        normalizeSegment(r[0]) === normalizeSegment(tr[tr.length - 1])) {
        r = r.slice(1);
      }
      const untranslated = parsed.origin + "/" + [...tr, ...r].join("/");
      candidates.add(untranslated);
      if (segments) {
        const translatedParts = r.map((part) => {
          const norm = normalizeSegment(part);
          return segments.has(norm) ? segments.get(norm)! : part;
        });
        const translated = parsed.origin + "/" + [...tr, ...translatedParts].join("/");
        if (translated !== untranslated) candidates.add(translated);
      }
    };

    const pairMappings = tabPatterns.rootMappings.get(lang) || [];
    let perPairMatched = false;
    for (const mapping of pairMappings) {
      let matchLen = 0;
      for (let i = 0; i < mapping.sourceRoot.length && i < cleanParts.length; i++) {
        if (normalizeSegment(cleanParts[i]) === normalizeSegment(mapping.sourceRoot[i])) {
          matchLen++;
        } else {
          break;
        }
      }
      if (matchLen === mapping.sourceRoot.length && matchLen >= commonSourceRoot.length) {
        buildUrl(mapping.targetRoot, cleanParts.slice(matchLen));
        perPairMatched = true;
      }
    }

    if (!perPairMatched) {
      if (commonSourceRoot.length > 0) {
        let matchLen = 0;
        for (let i = 0; i < commonSourceRoot.length && i < cleanParts.length; i++) {
          if (normalizeSegment(cleanParts[i]) === normalizeSegment(commonSourceRoot[i])) {
            matchLen++;
          } else {
            break;
          }
        }
        buildUrl(commonTargetRoot, cleanParts.slice(matchLen));
      } else {
        buildUrl(commonTargetRoot, cleanParts);
      }
    }

    const suffixRule = langSuffixRuleFor(tabPatterns, lang);
    if (
      !perPairMatched &&
      suffixRule &&
      cleanParts.length > suffixRule.depth &&
      !cleanParts[suffixRule.depth].toLowerCase().endsWith(suffixRule.suffix.toLowerCase())
    ) {
      const transformed = cleanParts.map((p, i) => {
        if (i === suffixRule.depth) return p + suffixRule.suffix;
        return p;
      });
      const candidate = parsed.origin + "/" + [...suffixRule.prefix, ...transformed].join("/");
      candidates.add(candidate);
      if (segments) {
        const translatedKeepDepth = transformed.map((part, i) => {
          if (i === suffixRule.depth) return part;
          const norm = normalizeSegment(part);
          return segments.has(norm) ? segments.get(norm)! : part;
        });
        const tCandidate1 = parsed.origin + "/" + [...suffixRule.prefix, ...translatedKeepDepth].join("/");
        if (tCandidate1 !== candidate) candidates.add(tCandidate1);

        const translatedAll = cleanParts.map((part, i) => {
          const norm = normalizeSegment(part);
          const base = segments.has(norm) ? segments.get(norm)! : part;
          if (i === suffixRule.depth) return base + suffixRule.suffix;
          return base;
        });
        const tCandidate2 = parsed.origin + "/" + [...suffixRule.prefix, ...translatedAll].join("/");
        if (tCandidate2 !== candidate && tCandidate2 !== tCandidate1) candidates.add(tCandidate2);
      }
    }

    if (suffixRule) {
      const existing = Array.from(candidates);
      for (const c of existing) {
        const suffixed = appendFilenameSuffix(c, suffixRule.suffix);
        if (suffixed) candidates.add(suffixed);
      }
    }
  } catch {}
  return Array.from(candidates);
}

export async function validatePatterns(
  tabPatterns: TabPatterns,
  sampleUrls: { sourceUrl: string; lang: TargetLang }[]
): Promise<Record<TargetLang, number>> {
  const samplesByLang: Record<string, string[]> = { en: [], fr: [], ru: [], ar: [] };

  for (const sample of sampleUrls) {
    const { translated, untranslated } = constructTargetUrl(sample.sourceUrl, sample.lang, tabPatterns);
    const candidate = untranslated || translated;
    if (candidate) samplesByLang[sample.lang].push(candidate);
    if (translated && translated !== candidate) samplesByLang[sample.lang].push(translated);
  }

  const allUrls = Object.values(samplesByLang).flat();
  if (allUrls.length === 0) return { en: 0, fr: 0, ru: 0, ar: 0 };

  const existence = await batchHeadCheck(allUrls);

  const result: Record<string, number> = {};
  const langs: TargetLang[] = ["en", "fr", "ru", "ar"];
  const parts: string[] = [];
  for (const l of langs) {
    let valid = 0;
    for (const url of samplesByLang[l]) { if (existence.get(url)?.ok) valid++; }
    result[l] = valid;
    const rate = samplesByLang[l].length > 0 ? valid / samplesByLang[l].length : 0;
    tabPatterns.patternValidated[l] = rate >= 0.3;
    if (samplesByLang[l].length > 0) parts.push(`${l.toUpperCase()} ${valid}/${samplesByLang[l].length} (${(rate * 100).toFixed(0)}%)`);
  }
  log(`  Pattern validation: ${parts.join(", ")}`);

  return result as Record<TargetLang, number>;
}

export interface BatchMatchResult {
  enUrl: string | null;
  frUrl: string | null;
  ruUrl: string | null;
  arUrl: string | null;
  confidenceEn: number | null;
  confidenceFr: number | null;
  confidenceRu: number | null;
  confidenceAr: number | null;
  matchMethodEn: string | null;
  matchMethodFr: string | null;
  matchMethodRu: string | null;
  matchMethodAr: string | null;
}

export function emptyBatchResult(): BatchMatchResult {
  return {
    enUrl: null, frUrl: null, ruUrl: null, arUrl: null,
    confidenceEn: null, confidenceFr: null, confidenceRu: null, confidenceAr: null,
    matchMethodEn: null, matchMethodFr: null, matchMethodRu: null, matchMethodAr: null,
  };
}

export function getResultUrl(r: BatchMatchResult, lang: TargetLang): string | null {
  return { en: r.enUrl, fr: r.frUrl, ru: r.ruUrl, ar: r.arUrl }[lang];
}
export function getResultConf(r: BatchMatchResult, lang: TargetLang): number | null {
  return { en: r.confidenceEn, fr: r.confidenceFr, ru: r.confidenceRu, ar: r.confidenceAr }[lang];
}
export function getResultMethod(r: BatchMatchResult, lang: TargetLang): string | null {
  return { en: r.matchMethodEn, fr: r.matchMethodFr, ru: r.matchMethodRu, ar: r.matchMethodAr }[lang];
}
export function setResultMatch(r: BatchMatchResult, lang: TargetLang, url: string, confidence: number, method: string) {
  if (lang === "en") { r.enUrl = url; r.confidenceEn = confidence; r.matchMethodEn = method; }
  else if (lang === "fr") { r.frUrl = url; r.confidenceFr = confidence; r.matchMethodFr = method; }
  else if (lang === "ru") { r.ruUrl = url; r.confidenceRu = confidence; r.matchMethodRu = method; }
  else if (lang === "ar") { r.arUrl = url; r.confidenceAr = confidence; r.matchMethodAr = method; }
}
export function clearResultMatch(r: BatchMatchResult, lang: TargetLang) {
  if (lang === "en") { r.enUrl = null; r.confidenceEn = null; r.matchMethodEn = null; }
  else if (lang === "fr") { r.frUrl = null; r.confidenceFr = null; r.matchMethodFr = null; }
  else if (lang === "ru") { r.ruUrl = null; r.confidenceRu = null; r.matchMethodRu = null; }
  else if (lang === "ar") { r.arUrl = null; r.confidenceAr = null; r.matchMethodAr = null; }
}

export function batchConstructUrls(
  sourceUrls: { sourceUrl: string; needs: Record<TargetLang, boolean>; index: number }[],
  tabPatterns: TabPatterns
): Map<number, BatchMatchResult> {
  const results = new Map<number, BatchMatchResult>();
  const langs: TargetLang[] = ["en", "fr", "ru", "ar"];

  for (const item of sourceUrls) {
    const result = emptyBatchResult();

    for (const lang of langs) {
      if (item.needs[lang] && tabPatterns.patternValidated[lang]) {
        const { translated, untranslated } = constructTargetUrl(item.sourceUrl, lang, tabPatterns);
        const url = translated || untranslated;
        if (url) setResultMatch(result, lang, url, 90, "pattern");
      }
    }

    results.set(item.index, result);
  }

  return results;
}

const CRAWL_CONCURRENCY = 30;
const CRAWL_TIMEOUT = 8000;
const CRAWL_MAX_PAGES = 10000;

export interface CrawlInventory {
  urls: Set<string>;
  normalizedIndex: Map<string, string>;
  tailIndex: Map<string, string[]>;
  titleIndex: Map<string, string>;
  lastSegWordIndex: Map<string, Set<string>>;
  titleEmbeddings?: Map<string, number[]>;
}

export function mergeInventories(invs: (CrawlInventory | null | undefined)[]): CrawlInventory | null {
  const nonNull = invs.filter((i): i is CrawlInventory => !!i && i.urls.size > 0);
  if (nonNull.length === 0) return null;
  if (nonNull.length === 1) return nonNull[0];
  const merged: CrawlInventory = {
    urls: new Set(),
    normalizedIndex: new Map(),
    tailIndex: new Map(),
    titleIndex: new Map(),
    lastSegWordIndex: new Map(),
  };
  for (const inv of nonNull) {
    for (const u of Array.from(inv.urls)) merged.urls.add(u);
    for (const [k, v] of Array.from(inv.normalizedIndex)) {
      if (!merged.normalizedIndex.has(k)) merged.normalizedIndex.set(k, v);
    }
    for (const [k, list] of Array.from(inv.tailIndex)) {
      const cur = merged.tailIndex.get(k);
      if (!cur) {
        merged.tailIndex.set(k, list.slice());
      } else {
        for (const u of list) if (!cur.includes(u)) cur.push(u);
      }
    }
    for (const [k, v] of Array.from(inv.titleIndex)) {
      if (!merged.titleIndex.has(k)) merged.titleIndex.set(k, v);
    }
    if (inv.titleEmbeddings && inv.titleEmbeddings.size > 0) {
      if (!merged.titleEmbeddings) merged.titleEmbeddings = new Map();
      for (const [k, v] of Array.from(inv.titleEmbeddings)) {
        if (!merged.titleEmbeddings.has(k)) merged.titleEmbeddings.set(k, v);
      }
    }
    for (const [k, set] of Array.from(inv.lastSegWordIndex)) {
      let cur = merged.lastSegWordIndex.get(k);
      if (!cur) {
        cur = new Set<string>();
        merged.lastSegWordIndex.set(k, cur);
      }
      for (const u of Array.from(set)) cur.add(u);
    }
  }
  return merged;
}

function normalizeUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const clean = stripSuffix(parts);
    return clean.map((p) => normalizeSegment(p)).join("/");
  } catch {
    return url.toLowerCase();
  }
}

function getUrlTail(url: string, tailLen: number = 2): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const clean = stripSuffix(parts);
    const tail = clean.slice(-tailLen);
    return tail.map((p) => normalizeSegment(p)).join("/");
  } catch {
    return "";
  }
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,fr;q=0.8,he;q=0.7,ar;q=0.6,ru;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

type FetchOutcome = { html: string | null; reason: "ok" | "http_4xx" | "http_5xx" | "non_html" | "timeout" | "error" | "aborted"; status?: number };

async function fetchPageDetailed(url: string, signal?: AbortSignal): Promise<FetchOutcome> {
  if (signal?.aborted) return { html: null, reason: "aborted" };
  const { signal: combined, cleanup } = combineSignals(signal, CRAWL_TIMEOUT);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: combined,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinguaMap/1.0; URL Mapper Bot)",
        "Accept": "text/html",
      },
      redirect: "follow",
    });
    cleanup();

    if (response.status === 401) {
      if (signal?.aborted) return { html: null, reason: "aborted" };
      const { signal: combined2, cleanup: cleanup2 } = combineSignals(signal, CRAWL_TIMEOUT);
      try {
        const retryResponse = await fetch(url, {
          method: "GET",
          signal: combined2,
          headers: {
            ...BROWSER_HEADERS,
            "Referer": new URL(url).origin + "/",
          },
          redirect: "follow",
        });
        cleanup2();
        if (!retryResponse.ok) {
          const r: FetchOutcome["reason"] = retryResponse.status >= 500 ? "http_5xx" : "http_4xx";
          return { html: null, reason: r, status: retryResponse.status };
        }
        const ct = retryResponse.headers.get("content-type") || "";
        if (!ct.includes("text/html")) return { html: null, reason: "non_html", status: retryResponse.status };
        return { html: await retryResponse.text(), reason: "ok", status: retryResponse.status };
      } catch (err: any) {
        cleanup2();
        if (signal?.aborted) return { html: null, reason: "aborted" };
        const isTimeout = err?.name === "AbortError";
        return { html: null, reason: isTimeout ? "timeout" : "error" };
      }
    }

    if (!response.ok) {
      const r: FetchOutcome["reason"] = response.status >= 500 ? "http_5xx" : "http_4xx";
      return { html: null, reason: r, status: response.status };
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return { html: null, reason: "non_html", status: response.status };
    return { html: await response.text(), reason: "ok", status: response.status };
  } catch (err: any) {
    cleanup();
    if (signal?.aborted) return { html: null, reason: "aborted" };
    const isTimeout = err?.name === "AbortError";
    return { html: null, reason: isTimeout ? "timeout" : "error" };
  }
}

async function fetchPage(url: string, signal?: AbortSignal): Promise<string | null> {
  return (await fetchPageDetailed(url, signal)).html;
}

function extractLinks(html: string, baseUrl: string, scopePrefix: string): string[] {
  const $ = cheerio.load(html);
  const links: Set<string> = new Set();
  const base = new URL(baseUrl);
  const scopeLower = scopePrefix.toLowerCase();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.origin !== base.origin) return;
      resolved.hash = "";
      resolved.search = "";
      const cleanUrl = resolved.toString();

      if (resolved.pathname.toLowerCase().startsWith(scopeLower)) {
        links.add(cleanUrl);
      }
    } catch {}
  });

  return Array.from(links);
}

export async function crawlDirectory(
  origin: string,
  rootPath: string[],
  onProgress?: (crawled: number, queued: number) => void,
  seedUrls?: string[],
  signal?: AbortSignal,
  maxPages?: number,
): Promise<CrawlInventory> {
  const pageCap = maxPages && maxPages > 0 ? Math.min(maxPages, CRAWL_MAX_PAGES) : CRAWL_MAX_PAGES;
  const inventory: CrawlInventory = {
    urls: new Set(),
    normalizedIndex: new Map(),
    tailIndex: new Map(),
    titleIndex: new Map(),
    lastSegWordIndex: new Map(),
  };

  const scopePrefix = "/" + rootPath.join("/");
  const startUrl = origin + scopePrefix + "/";

  const visited = new Set<string>();
  const queue: string[] = [startUrl];

  if (rootPath.length > 0) {
    const defaultUrl = origin + scopePrefix + "/Pages/default.aspx";
    queue.push(defaultUrl);
  }

  if (seedUrls) {
    for (const seed of seedUrls) {
      try {
        const seedParsed = new URL(seed);
        if (seedParsed.origin === origin && seedParsed.pathname.startsWith(scopePrefix)) {
          if (!visited.has(seed)) {
            queue.push(seed);
          }
        }
      } catch {}
    }
  }

  let crawled = 0;
  const reasonCounts: Record<string, number> = { ok: 0, http_4xx: 0, http_5xx: 0, non_html: 0, timeout: 0, error: 0, aborted: 0 };
  const sampleByReason: Record<string, string> = {};

  while (queue.length > 0 && crawled < pageCap) {
    if (signal?.aborted) break;
    const batch = queue.splice(0, CRAWL_CONCURRENCY);
    const toFetch = batch.filter((url) => !visited.has(url));
    for (const url of toFetch) visited.add(url);

    if (toFetch.length === 0) continue;

    const results = await Promise.all(
      toFetch.map(async (url) => {
        const outcome = await fetchPageDetailed(url, signal);
        return { url, html: outcome.html, reason: outcome.reason, status: outcome.status };
      })
    );

    for (const { url, html, reason, status } of results) {
      crawled++;
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      if (reason !== "ok" && reason !== "aborted" && !sampleByReason[reason]) {
        sampleByReason[reason] = `${url}${status ? ` (${status})` : ""}`;
      }

      if (html) {
        addToInventory(inventory, url);

        const $ = cheerio.load(html);
        const pageTitle = $("title").first().text().trim();
        const lowerTitle = (pageTitle || "").toLowerCase();
        const titleIsError = lowerTitle.includes("page not found") ||
          lowerTitle.includes("404 -") ||
          lowerTitle.includes("שגיאה") ||
          lowerTitle.includes("הדף לא נמצא");

        const htmlSnippet = html.slice(0, 8000);
        const spSoftRedirect = /window\.location\.replace\s*\(\s*['"][^'"]*(?:PageNotFoundError|PageNotFound|404)[^'"]*['"]\s*\)/i.test(htmlSnippet) ||
          /window\.location\.href\s*=\s*['"][^'"]*(?:PageNotFoundError|PageNotFound|404)[^'"]*['"]/i.test(htmlSnippet);
        const spErrorMeta = !!$('meta[name="SharePointError"], meta[name="sharepointerror"]').length;
        const robotsMeta = ($('meta[name="Robots"], meta[name="robots"]').attr("content") || "").toUpperCase();
        const spNoIndex = robotsMeta.includes("NOINDEX");
        const spMetaError = spErrorMeta || (spNoIndex && lowerTitle === "");

        const isErrorPage = titleIsError || spSoftRedirect || spMetaError;

        if (isErrorPage) {
          removeFromInventory(inventory, url);
        } else {
          let effectiveTitle = pageTitle || $("h1").first().text().trim();
          if (effectiveTitle) {
            effectiveTitle = effectiveTitle.replace(/\s*\|\s*ביטוח לאומי\s*$/, "").trim();
            inventory.titleIndex.set(url, effectiveTitle);
          }
        }

        const links = extractLinks(html, url, scopePrefix);
        for (const link of links) {
          if (!visited.has(link)) {
            queue.push(link);
          }
        }

        try {
          const parsed = new URL(url);
          const lowerPath = parsed.pathname.toLowerCase();
          if (lowerPath.endsWith("/pages/default.aspx") || lowerPath.endsWith("/pages/")) {
            const pagesDir = parsed.pathname.replace(/default\.aspx$/i, "");
            const pagesDirUrl = parsed.origin + pagesDir;
            if (!visited.has(pagesDirUrl)) {
              queue.push(pagesDirUrl);
            }
            const allItemsUrl = parsed.origin + pagesDir + "Forms/AllItems.aspx";
            if (!visited.has(allItemsUrl)) {
              queue.push(allItemsUrl);
            }
          }
        } catch {}
      }
    }

    if (onProgress) {
      onProgress(crawled, queue.length);
    }
  }

  const failed = crawled - (reasonCounts.ok || 0);
  if (failed > 0 || crawled >= pageCap) {
    const parts: string[] = [];
    for (const [r, n] of Object.entries(reasonCounts)) {
      if (n > 0) {
        const sample = sampleByReason[r] ? ` [e.g. ${sampleByReason[r]}]` : "";
        parts.push(`${r}=${n}${sample}`);
      }
    }
    log(`    Crawl summary for ${origin}/${rootPath.join("/")} → fetched=${crawled}, queued_remaining=${queue.length}, cap=${pageCap}, ${parts.join(", ")}${crawled >= pageCap ? ` (HIT CAP=${pageCap}; raise crawlPageCap or use Auto for deeper crawl)` : ""}`);
  }

  return inventory;
}

export interface SeedVerifyStats {
  checked: number;
  added: number;
  skippedKnown: number;
  failed: number;
  capped: number;
}

export async function verifySeedUrls(
  inventory: CrawlInventory,
  seeds: string[],
  signal?: AbortSignal,
  ceiling: number = 3000,
): Promise<SeedVerifyStats> {
  const stats: SeedVerifyStats = { checked: 0, added: 0, skippedKnown: 0, failed: 0, capped: 0 };

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const s of seeds) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (inventory.urls.has(s) || inventory.normalizedIndex.has(normalizeUrlPath(s))) {
      stats.skippedKnown++;
      continue;
    }
    unique.push(s);
  }

  if (unique.length > ceiling) {
    stats.capped = unique.length - ceiling;
    unique.length = ceiling;
  }

  for (let i = 0; i < unique.length; i += CRAWL_CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = unique.slice(i, i + CRAWL_CONCURRENCY);
    const results = await Promise.all(batch.map(async (url) => {
      const outcome = await fetchPageDetailed(url, signal);
      return { url, outcome };
    }));
    for (const { url, outcome } of results) {
      stats.checked++;
      if (outcome.reason !== "ok" || !outcome.html) {
        stats.failed++;
        continue;
      }
      const $ = cheerio.load(outcome.html);
      const pageTitle = $("title").first().text().trim();
      const lowerTitle = (pageTitle || "").toLowerCase();
      const titleIsError = lowerTitle.includes("page not found") ||
        lowerTitle.includes("404 -") ||
        lowerTitle.includes("שגיאה") ||
        lowerTitle.includes("הדף לא נמצא");
      const htmlSnippet = outcome.html.slice(0, 8000);
      const spSoftRedirect = /window\.location\.replace\s*\(\s*['"][^'"]*(?:PageNotFoundError|PageNotFound|404)[^'"]*['"]\s*\)/i.test(htmlSnippet) ||
        /window\.location\.href\s*=\s*['"][^'"]*(?:PageNotFoundError|PageNotFound|404)[^'"]*['"]/i.test(htmlSnippet);
      const spErrorMeta = !!$('meta[name="SharePointError"], meta[name="sharepointerror"]').length;
      const robotsMeta = ($('meta[name="Robots"], meta[name="robots"]').attr("content") || "").toUpperCase();
      const spNoIndex = robotsMeta.includes("NOINDEX");
      const spMetaError = spErrorMeta || (spNoIndex && lowerTitle === "");
      if (titleIsError || spSoftRedirect || spMetaError) {
        stats.failed++;
        continue;
      }
      addToInventory(inventory, url);
      let effectiveTitle = pageTitle || $("h1").first().text().trim();
      if (effectiveTitle) {
        effectiveTitle = effectiveTitle.replace(/\s*\|\s*ביטוח לאומי\s*$/, "").trim();
        inventory.titleIndex.set(url, effectiveTitle);
      }
      stats.added++;
    }
  }

  return stats;
}

function removeFromInventory(inventory: CrawlInventory, url: string) {
  inventory.urls.delete(url);
  const normalized = normalizeUrlPath(url);
  inventory.normalizedIndex.delete(normalized);
  inventory.titleIndex.delete(url);

  for (let tailLen = 1; tailLen <= 3; tailLen++) {
    const tail = getUrlTail(url, tailLen);
    if (tail && inventory.tailIndex.has(tail)) {
      const arr = inventory.tailIndex.get(tail)!;
      const idx = arr.indexOf(url);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) inventory.tailIndex.delete(tail);
    }
  }

  const normParts = normalized.split("/");
  const lastSeg = normParts[normParts.length - 1];
  if (lastSeg && lastSeg.length > 2) {
    const words = lastSeg.replace(/[_\-%20]+/g, " ").split(" ").filter(w => w.length > 2);
    for (const word of words) {
      const set = inventory.lastSegWordIndex.get(word);
      if (set) {
        set.delete(normalized);
        if (set.size === 0) inventory.lastSegWordIndex.delete(word);
      }
    }
  }
}

function addToInventory(inventory: CrawlInventory, url: string) {
  if (inventory.urls.has(url)) return;
  inventory.urls.add(url);

  const normalized = normalizeUrlPath(url);
  inventory.normalizedIndex.set(normalized, url);

  for (let tailLen = 1; tailLen <= 3; tailLen++) {
    const tail = getUrlTail(url, tailLen);
    if (tail) {
      if (!inventory.tailIndex.has(tail)) {
        inventory.tailIndex.set(tail, []);
      }
      inventory.tailIndex.get(tail)!.push(url);
    }
  }

  const normParts = normalized.split("/");
  const lastSeg = normParts[normParts.length - 1];
  if (lastSeg && lastSeg.length > 2) {
    const words = lastSeg.replace(/[_\-%20]+/g, " ").split(" ").filter(w => w.length > 2);
    for (const word of words) {
      if (!inventory.lastSegWordIndex.has(word)) {
        inventory.lastSegWordIndex.set(word, new Set());
      }
      inventory.lastSegWordIndex.get(word)!.add(normalized);
    }
  }
}

function fuzzySegmentMatch(
  srcTailParts: string[],
  lang: TargetLang,
  tabPatterns: TabPatterns,
  inventory: CrawlInventory
): { url: string; confidence: number; method: string } | null {
  const segments = tabPatterns.segmentMap.get(lang);
  const lastSrc = normalizeSegment(srcTailParts[srcTailParts.length - 1]);
  if (!lastSrc || lastSrc === "pages" || lastSrc.length <= 3) return null;

  const srcWords = lastSrc.replace(/[_\-%20]+/g, " ").split(" ").filter(w => w.length > 2);
  if (srcWords.length === 0) return null;

  const candidateNorms = new Set<string>();
  for (const word of srcWords) {
    const urls = inventory.lastSegWordIndex.get(word);
    if (urls) {
      Array.from(urls).forEach(u => candidateNorms.add(u));
    }
  }

  if (candidateNorms.size > 0) {
    const result = bestJaccardMatch(srcWords, candidateNorms, inventory);
    if (result) return { url: result.url, confidence: Math.round(80 + result.score * 10), method: "segment-fuzzy" };
  }

  if (segments) {
    const translatedLast = segments.has(lastSrc) ? normalizeSegment(segments.get(lastSrc)!) : lastSrc;
    if (translatedLast !== lastSrc) {
      const transWords = translatedLast.replace(/[_\-%20]+/g, " ").split(" ").filter(w => w.length > 2);
      if (transWords.length > 0) {
        const transCandidates = new Set<string>();
        for (const word of transWords) {
          const urls = inventory.lastSegWordIndex.get(word);
          if (urls) {
            Array.from(urls).forEach(u => transCandidates.add(u));
          }
        }

        if (transCandidates.size > 0) {
          const result = bestJaccardMatch(transWords, transCandidates, inventory);
          if (result) return { url: result.url, confidence: Math.round(80 + result.score * 10), method: "segment-fuzzy-translated" };
        }
      }
    }
  }

  return null;
}

function bestJaccardMatch(
  srcWords: string[],
  candidateNorms: Set<string>,
  inventory: CrawlInventory
): { url: string; score: number } | null {
  let best: { url: string; score: number } | null = null;
  const srcSet = new Set(srcWords);

  for (const normUrl of Array.from(candidateNorms)) {
    const parts = normUrl.split("/");
    const lastSeg = parts[parts.length - 1];
    if (!lastSeg || lastSeg.length < 3) continue;

    const invWords = new Set(lastSeg.replace(/[_\-%20]+/g, " ").split(" ").filter((w: string) => w.length > 2));
    if (invWords.size === 0) continue;

    let overlap = 0;
    Array.from(srcSet).forEach(w => {
      if (invWords.has(w)) overlap++;
    });
    const total = srcSet.size + invWords.size - overlap;
    const score = total > 0 ? overlap / total : 0;

    if (score >= 0.6 && overlap >= 2 && (!best || score > best.score)) {
      const realUrl = inventory.normalizedIndex.get(normUrl);
      if (realUrl) best = { url: realUrl, score };
    }
  }

  return best;
}

function getSourceSectionSegment(sourceUrl: string, sourceRoot: string[]): string | null {
  try {
    const parsed = new URL(sourceUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const cleanParts = stripSuffix(parts);
    const afterRoot = sourceRoot.length > 0 ? cleanParts.slice(sourceRoot.length) : cleanParts;
    if (afterRoot.length > 0) {
      const seg = normalizeSegment(afterRoot[0]);
      if (seg && seg !== "pages" && seg !== "default.aspx" && seg.length > 2) {
        return seg;
      }
    }
  } catch {}
  return null;
}

function validateSectionContext(
  candidateUrl: string,
  sourceUrl: string,
  lang: TargetLang,
  tabPatterns: TabPatterns
): boolean {
  const sourceRoot = langSrcRoot(tabPatterns, lang);
  const targetRoot = langRoot(tabPatterns, lang);
  const segments = tabPatterns.segmentMap.get(lang);

  const pairMappings = tabPatterns.rootMappings.get(lang) || [];

  try {
    const sourceParts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    const cleanSrc = stripSuffix(sourceParts);

    let bestPairTgtRoot: string[] | null = null;
    let bestPairMatchLen = 0;

    for (const mapping of pairMappings) {
      if (mapping.sourceRoot.length <= bestPairMatchLen) continue;
      let matchLen = 0;
      for (let i = 0; i < mapping.sourceRoot.length && i < cleanSrc.length; i++) {
        if (normalizeSegment(cleanSrc[i]) === normalizeSegment(mapping.sourceRoot[i])) {
          matchLen++;
        } else break;
      }
      if (matchLen === mapping.sourceRoot.length && matchLen > bestPairMatchLen) {
        bestPairTgtRoot = mapping.targetRoot;
        bestPairMatchLen = matchLen;
      }
    }

    if (bestPairTgtRoot && bestPairMatchLen > sourceRoot.length) {
      const candidateParts = new URL(candidateUrl).pathname.split("/").filter(Boolean);
      const candidateNorm = candidateParts.slice(0, bestPairTgtRoot.length).map(s => normalizeSegment(s)).join("/");
      const pairTgtNorm = bestPairTgtRoot.map(s => normalizeSegment(s)).join("/");
      return candidateNorm === pairTgtNorm;
    }
  } catch {}

  const srcSection = getSourceSectionSegment(sourceUrl, sourceRoot);
  if (!srcSection) return true;

  try {
    const candidateParts = new URL(candidateUrl).pathname.split("/").filter(Boolean);
    const afterRoot = candidateParts.slice(targetRoot.length);
    if (afterRoot.length === 0) return true;

    const candidateSection = normalizeSegment(afterRoot[0]);

    if (candidateSection === srcSection) return true;

    if (segments) {
      const translatedSection = segments.has(srcSection) ? normalizeSegment(segments.get(srcSection)!) : null;
      if (translatedSection && candidateSection === translatedSection) return true;
    }

    const srcWords = srcSection.replace(/[_\-%20]+/g, " ").split(" ").filter(w => w.length > 2);
    const candWords = candidateSection.replace(/[_\-%20]+/g, " ").split(" ").filter(w => w.length > 2);
    if (srcWords.length > 0 && candWords.length > 0) {
      let overlap = 0;
      for (const w of srcWords) {
        if (candWords.some(cw => cw === w || (w.length > 4 && cw.includes(w)) || (cw.length > 4 && w.includes(cw)))) {
          overlap++;
        }
      }
      if (overlap > 0) return true;
    }

    return false;
  } catch {
    return true;
  }
}

export function validateDepthMatch(
  sourceUrl: string,
  candidateUrl: string,
  sourceRoot: string[],
  targetRoot: string[]
): boolean {
  try {
    const srcParts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    const srcClean = stripSuffix(srcParts);
    const srcDepthAfterRoot = srcClean.length - sourceRoot.length;

    const tgtParts = new URL(candidateUrl).pathname.split("/").filter(Boolean);
    const tgtClean = stripSuffix(tgtParts);
    const tgtDepthAfterRoot = tgtClean.length - targetRoot.length;

    if (srcDepthAfterRoot >= 2 && tgtDepthAfterRoot <= 0) {
      return false;
    }

    if (srcDepthAfterRoot >= 3 && tgtDepthAfterRoot <= 1) {
      return false;
    }

    return true;
  } catch {
    return true;
  }
}

function disambiguateByDepth(
  sourceUrl: string,
  candidates: string[],
  sourceRoot: string[],
  targetRoot: string[]
): string | null {
  try {
    const srcParts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    const srcClean = stripSuffix(srcParts);
    const srcDepth = srcClean.length - sourceRoot.length;

    let bestCandidate: string | null = null;
    let bestScore = -1;
    let tiedCount = 0;

    for (const candidate of candidates) {
      if (!validateDepthMatch(sourceUrl, candidate, sourceRoot, targetRoot)) continue;

      const tgtParts = new URL(candidate).pathname.split("/").filter(Boolean);
      const tgtClean = stripSuffix(tgtParts);
      const tgtDepth = tgtClean.length - targetRoot.length;

      const depthDiff = Math.abs(srcDepth - tgtDepth);
      const srcTail = srcClean.slice(sourceRoot.length).map(s => normalizeSegment(s));
      const tgtTail = tgtClean.slice(targetRoot.length).map(s => normalizeSegment(s));
      let sharedSegs = 0;
      for (const s of srcTail) {
        if (tgtTail.includes(s)) sharedSegs++;
      }

      const score = sharedSegs * 10 - depthDiff;
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
        tiedCount = 1;
      } else if (score === bestScore) {
        tiedCount++;
      }
    }

    if (tiedCount === 1 && bestCandidate) return bestCandidate;
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect tabs/languages where source URL slugs and target inventory slugs are in
 * different writing systems / vocabularies (e.g. EN source `/benefits/Disability`
 * vs RU inventory `/Benefits_ru/Nehut_ru/` — Hebrew transliterations). For these
 * pairs the standard "no shared path segments → reject" safety rail in title
 * matching is a false-positive generator. Returns true per lang when fewer than
 * `threshold` of reference (sourceUrl, targetUrl) pairs share any normalized
 * path segment, with at least `minPairs` pairs to be statistically meaningful.
 */
export function detectCrossScriptLangs(
  refRows: { sourceUrl: string; enUrl?: string; frUrl?: string; ruUrl?: string; arUrl?: string }[],
  langs: TargetLang[],
  minPairs: number = 5,
  threshold: number = 0.30,
): Record<TargetLang, boolean> {
  const result: Record<TargetLang, boolean> = { en: false, fr: false, ru: false, ar: false };
  const refUrlKey: Record<TargetLang, "enUrl" | "frUrl" | "ruUrl" | "arUrl"> = {
    en: "enUrl", fr: "frUrl", ru: "ruUrl", ar: "arUrl",
  };
  for (const lang of langs) {
    const pairs: Array<{ s: Set<string>; t: Set<string> }> = [];
    for (const ref of refRows) {
      const tgt = ref[refUrlKey[lang]];
      if (!tgt) continue;
      try {
        const sParts = new URL(ref.sourceUrl).pathname.split("/").filter(Boolean);
        const tParts = new URL(tgt).pathname.split("/").filter(Boolean);
        const sSet = new Set(
          sParts.map(s => normalizeSegment(s)).filter(s => s && s !== "pages" && s !== "default.aspx"),
        );
        const tSet = new Set(
          tParts.map(s => normalizeSegment(s)).filter(s => s && s !== "pages" && s !== "default.aspx"),
        );
        if (sSet.size > 0 && tSet.size > 0) pairs.push({ s: sSet, t: tSet });
      } catch {}
    }
    if (pairs.length < minPairs) continue;
    let withOverlap = 0;
    for (const { s, t } of pairs) {
      let shared = false;
      for (const seg of s) { if (t.has(seg)) { shared = true; break; } }
      if (shared) withOverlap++;
    }
    const overlapFrac = withOverlap / pairs.length;
    if (overlapFrac < threshold) {
      result[lang] = true;
      log(`  [cross-script] ${lang.toUpperCase()}: ${withOverlap}/${pairs.length} ref pairs share path segments (${(overlapFrac * 100).toFixed(0)}%) — relaxing title-match segment-overlap rail for this lang`);
    }
  }
  return result;
}

/**
 * Pass 1.5 — alternate-link harvest. For source URLs that Pass 1 (pattern+crawl)
 * could not place, fetch the source HTML once and look for `<link rel="alternate"
 * hreflang="…">` tags (and `<a hreflang="…">` switcher links). Resolved hrefs
 * are validated against the target-language inventory; only inventory hits are
 * returned. Cheap, deterministic, and especially valuable on cross-script tabs
 * where Pass 1's segment translator is starved of training pairs.
 */
export interface AlternateLinkHarvestResult {
  matches: Map<string, Partial<Record<TargetLang, string>>>;
  attempted: number;
  fetched: number;
  cacheHits: number;
  pagesWithAnyAlternate: number;
  pagesWithInventoryHit: number;
  perLangAccepted: Record<TargetLang, number>;
  perLangRejectedNotInInventory: Record<TargetLang, number>;
}

/**
 * Per-source-URL cache of parsed alternate-link results. Shared across multi-pass
 * reruns within the same job so identical source pages are not re-fetched.
 * Cached value is the *raw* per-lang resolved-href map (before inventory check)
 * plus a flag for "page had at least one alternate tag at all". Inventory
 * filtering is re-applied each call because inventories can grow between passes.
 */
export interface AlternateLinkCacheEntry {
  /** All resolved hreflang hrefs per lang, in document order. We keep the full
   * list (deduped) so the inventory check can fall through to the next
   * candidate when the first one isn't a canonical inventory URL. */
  rawByLang: Partial<Record<TargetLang, string[]>>;
  hadAnyAlternate: boolean;
  fetchOk: boolean;
}
export type AlternateLinkCache = Map<string, AlternateLinkCacheEntry>;

export async function harvestAlternateLinks(
  sources: { sourceUrl: string; needs: Partial<Record<TargetLang, boolean>> }[],
  inventories: Record<TargetLang, CrawlInventory | null>,
  signal?: AbortSignal,
  concurrency: number = 6,
  cache?: AlternateLinkCache,
): Promise<AlternateLinkHarvestResult> {
  const matches = new Map<string, Partial<Record<TargetLang, string>>>();
  const perLangAccepted: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  const perLangRejectedNotInInventory: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  let attempted = 0;
  let fetched = 0;
  let cacheHits = 0;
  let pagesWithAnyAlternate = 0;
  let pagesWithInventoryHit = 0;

  const checkInventory = (lang: TargetLang, candidate: string): string | null => {
    const inv = inventories[lang];
    if (!inv) return null;
    let url: URL;
    try { url = new URL(candidate); } catch { return null; }
    url.hash = ""; url.search = "";
    const cleaned = url.toString();
    if (inv.urls.has(cleaned)) return cleaned;
    const norm = normalizeUrlPath(cleaned);
    return inv.normalizedIndex.get(norm) || null;
  };

  const parsePage = (html: string, sourceUrl: string): AlternateLinkCacheEntry => {
    let $: cheerio.CheerioAPI;
    try { $ = cheerio.load(html); } catch {
      return { rawByLang: {}, hadAnyAlternate: false, fetchOk: true };
    }
    const rawByLang: Partial<Record<TargetLang, string[]>> = {};
    let hadAny = false;
    $('link[rel="alternate"][hreflang], a[hreflang]').each((_, el) => {
      const hrefRaw = $(el).attr("href");
      const hl = ($(el).attr("hreflang") || "").toLowerCase().split("-")[0];
      if (!hrefRaw || !hl) return;
      if (!(["en", "fr", "ru", "ar"] as string[]).includes(hl)) return;
      const lang = hl as TargetLang;
      hadAny = true;
      let resolved: string;
      try { resolved = new URL(hrefRaw, sourceUrl).toString(); } catch { return; }
      const list = rawByLang[lang] || (rawByLang[lang] = []);
      if (!list.includes(resolved)) list.push(resolved);
    });
    return { rawByLang, hadAnyAlternate: hadAny, fetchOk: true };
  };

  for (let i = 0; i < sources.length; i += concurrency) {
    if (signal?.aborted) break;
    const batch = sources.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      if (signal?.aborted) return;
      attempted++;
      let entry = cache?.get(item.sourceUrl);
      if (entry) {
        cacheHits++;
      } else {
        const outcome = await fetchPageDetailed(item.sourceUrl, signal);
        fetched++;
        if (!outcome.html) {
          entry = { rawByLang: {}, hadAnyAlternate: false, fetchOk: false };
        } else {
          entry = parsePage(outcome.html, item.sourceUrl);
        }
        cache?.set(item.sourceUrl, entry);
      }
      if (entry.hadAnyAlternate) pagesWithAnyAlternate++;
      const found: Partial<Record<TargetLang, string>> = {};
      for (const lang of ["en", "fr", "ru", "ar"] as TargetLang[]) {
        if (!item.needs[lang]) continue;
        const candidates = entry.rawByLang[lang];
        if (!candidates || candidates.length === 0) continue;
        let accepted: string | null = null;
        for (const cand of candidates) {
          const matched = checkInventory(lang, cand);
          if (matched) { accepted = matched; break; }
        }
        if (accepted) {
          found[lang] = accepted;
          perLangAccepted[lang]++;
        } else {
          perLangRejectedNotInInventory[lang]++;
        }
      }
      if (Object.keys(found).length > 0) {
        pagesWithInventoryHit++;
        matches.set(item.sourceUrl, found);
      }
    }));
    await abortAwareSleep(150, signal);
  }
  return {
    matches, attempted, fetched, cacheHits,
    pagesWithAnyAlternate, pagesWithInventoryHit,
    perLangAccepted, perLangRejectedNotInInventory,
  };
}

export function matchAgainstInventory(
  sourceUrl: string,
  lang: TargetLang,
  tabPatterns: TabPatterns,
  inventory: CrawlInventory
): { url: string; confidence: number; method: string } | null {
  const sourceRoot = langSrcRoot(tabPatterns, lang);
  const targetRoot = langRoot(tabPatterns, lang);

  const allCandidates = constructAllTargetUrls(sourceUrl, lang, tabPatterns);

  for (const candidate of allCandidates) {
    if (!validateDepthMatch(sourceUrl, candidate, sourceRoot, targetRoot)) continue;
    if (inventory.urls.has(candidate)) {
      return { url: candidate, confidence: 96, method: "pattern-direct+crawl" };
    }
    const norm = normalizeUrlPath(candidate);
    const inventoryUrl = inventory.normalizedIndex.get(norm);
    if (inventoryUrl) {
      return { url: inventoryUrl, confidence: 94, method: "pattern-direct+crawl-norm" };
    }
  }

  try {
    const parsed = new URL(sourceUrl);
    const srcParts = parsed.pathname.split("/").filter(Boolean);
    const cleanSrc = stripSuffix(srcParts);

    const pairMappings = tabPatterns.rootMappings.get(lang) || [];
    let bestPairSrcRoot = sourceRoot;
    let bestPairTgtRoot = targetRoot;
    let bestPairMatchLen = 0;

    for (const mapping of pairMappings) {
      if (mapping.sourceRoot.length <= bestPairMatchLen) continue;
      let matchLen = 0;
      for (let i = 0; i < mapping.sourceRoot.length && i < cleanSrc.length; i++) {
        if (normalizeSegment(cleanSrc[i]) === normalizeSegment(mapping.sourceRoot[i])) {
          matchLen++;
        } else break;
      }
      if (matchLen === mapping.sourceRoot.length && matchLen > bestPairMatchLen) {
        bestPairSrcRoot = mapping.sourceRoot;
        bestPairTgtRoot = mapping.targetRoot;
        bestPairMatchLen = matchLen;
      }
    }

    let srcTailParts: string[];
    const effectiveSrcRoot = bestPairMatchLen > sourceRoot.length ? bestPairSrcRoot : sourceRoot;
    if (effectiveSrcRoot.length > 0) {
      let matchLen = 0;
      for (let i = 0; i < effectiveSrcRoot.length && i < cleanSrc.length; i++) {
        if (normalizeSegment(cleanSrc[i]) === normalizeSegment(effectiveSrcRoot[i])) {
          matchLen++;
        } else break;
      }
      srcTailParts = cleanSrc.slice(matchLen);
    } else {
      srcTailParts = cleanSrc;
    }

    const effectiveTgtRoot = bestPairMatchLen > sourceRoot.length ? bestPairTgtRoot : targetRoot;

    if (effectiveTgtRoot.length > 0 && srcTailParts.length >= 1) {
      const lastSeg = normalizeSegment(srcTailParts[srcTailParts.length - 1]);
      if (lastSeg && lastSeg !== "pages") {
        const tgtRootNorm = effectiveTgtRoot.map(s => normalizeSegment(s)).join("/");
        const rootFilter = (c: string) => {
          try {
            const cParts = new URL(c).pathname.split("/").filter(Boolean);
            const cRootNorm = cParts.slice(0, effectiveTgtRoot.length).map(s => normalizeSegment(s)).join("/");
            return cRootNorm === tgtRootNorm;
          } catch { return false; }
        };

        for (let tailLen = 1; tailLen <= Math.min(srcTailParts.length, 3); tailLen++) {
          const tailKey = srcTailParts.slice(-tailLen).map(s => normalizeSegment(s)).join("/");
          const candidates = inventory.tailIndex.get(tailKey) || [];
          const rootFiltered = candidates.filter(rootFilter);

          if (rootFiltered.length === 1) {
            if (validateDepthMatch(sourceUrl, rootFiltered[0], sourceRoot, targetRoot)) {
              return { url: rootFiltered[0], confidence: 92, method: "root-anchored-tail" };
            }
          } else if (rootFiltered.length > 1 && rootFiltered.length <= 5) {
            const best = disambiguateByDepth(sourceUrl, rootFiltered, sourceRoot, targetRoot);
            if (best) {
              return { url: best, confidence: 89, method: "root-anchored-tail-disambig" };
            }
          }
        }

        const segments = tabPatterns.segmentMap.get(lang);
        if (segments) {
          const translatedTail = srcTailParts.map(p => {
            const norm = normalizeSegment(p);
            return segments.has(norm) ? normalizeSegment(segments.get(norm)!) : norm;
          });
          const srcTailNorm = srcTailParts.map(s => normalizeSegment(s)).join("/");
          const transTailNorm = translatedTail.join("/");
          if (transTailNorm !== srcTailNorm) {
            for (let tailLen = 1; tailLen <= Math.min(translatedTail.length, 3); tailLen++) {
              const tailKey = translatedTail.slice(-tailLen).join("/");
              const candidates = inventory.tailIndex.get(tailKey) || [];
              const rootFiltered = candidates.filter(rootFilter);

              if (rootFiltered.length === 1) {
                if (validateDepthMatch(sourceUrl, rootFiltered[0], sourceRoot, targetRoot)) {
                  return { url: rootFiltered[0], confidence: 91, method: "root-anchored-translated-tail" };
                }
              } else if (rootFiltered.length > 1 && rootFiltered.length <= 5) {
                const best = disambiguateByDepth(sourceUrl, rootFiltered, sourceRoot, targetRoot);
                if (best) {
                  return { url: best, confidence: 88, method: "root-anchored-translated-tail-disambig" };
                }
              }
            }
          }
        }
      }
    }

    if (srcTailParts.length >= 1) {
      const lastSeg = normalizeSegment(srcTailParts[srcTailParts.length - 1]);
      if (lastSeg && lastSeg !== "pages") {
        const tail1 = lastSeg;
        const candidates = inventory.tailIndex.get(tail1) || [];

        const sectionFiltered = candidates.filter(c => validateSectionContext(c, sourceUrl, lang, tabPatterns));

        if (sectionFiltered.length === 1) {
          if (validateDepthMatch(sourceUrl, sectionFiltered[0], sourceRoot, targetRoot)) {
            return { url: sectionFiltered[0], confidence: 85, method: "crawl-tail" };
          }
        } else if (sectionFiltered.length > 1 && sectionFiltered.length <= 5) {
          const best = disambiguateByDepth(sourceUrl, sectionFiltered, sourceRoot, targetRoot);
          if (best) {
            return { url: best, confidence: 83, method: "crawl-tail-disambig" };
          }
        }

        if (srcTailParts.length >= 2 && (sectionFiltered.length > 1 || sectionFiltered.length === 0)) {
          const tail2 = srcTailParts.slice(-2).map((p) => normalizeSegment(p)).join("/");
          const candidates2 = inventory.tailIndex.get(tail2) || [];
          const sectionFiltered2 = candidates2.filter(c => validateSectionContext(c, sourceUrl, lang, tabPatterns));
          if (sectionFiltered2.length === 1) {
            if (validateDepthMatch(sourceUrl, sectionFiltered2[0], sourceRoot, targetRoot)) {
              return { url: sectionFiltered2[0], confidence: 88, method: "crawl-tail2" };
            }
          } else if (sectionFiltered2.length > 1 && sectionFiltered2.length <= 5) {
            const best = disambiguateByDepth(sourceUrl, sectionFiltered2, sourceRoot, targetRoot);
            if (best) {
              return { url: best, confidence: 86, method: "crawl-tail2-disambig" };
            }
          }
        }
      }
    }

    if (srcTailParts.length >= 1) {
      const segments = tabPatterns.segmentMap.get(lang);
      const translatedTail = srcTailParts.map((p) => {
        const norm = normalizeSegment(p);
        if (segments && segments.has(norm)) return normalizeSegment(segments.get(norm)!);
        return norm;
      });
      const srcNorm = srcTailParts.map(s => normalizeSegment(s)).join("/");
      const transNorm = translatedTail.join("/");

      if (transNorm !== srcNorm) {
        for (let tailLen = Math.min(translatedTail.length, 3); tailLen >= 1; tailLen--) {
          const tailKey = translatedTail.slice(-tailLen).join("/");
          const candidates = inventory.tailIndex.get(tailKey) || [];
          const sectionFiltered = candidates.filter(c => validateSectionContext(c, sourceUrl, lang, tabPatterns));
          if (sectionFiltered.length === 1) {
            if (validateDepthMatch(sourceUrl, sectionFiltered[0], sourceRoot, targetRoot)) {
              return { url: sectionFiltered[0], confidence: 86, method: "crawl-translated-tail" };
            }
          }
        }
      }
    }

    if (srcTailParts.length >= 1) {
      const result = fuzzySegmentMatch(srcTailParts, lang, tabPatterns, inventory);
      if (result && validateSectionContext(result.url, sourceUrl, lang, tabPatterns) && validateDepthMatch(sourceUrl, result.url, sourceRoot, targetRoot)) {
        return result;
      }
    }
  } catch {}

  for (const candidate of allCandidates) {
    urlExistenceCache.set(candidate, { ok: false, finalUrl: candidate });
  }

  return null;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[-–—_|:]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(the|a|an|le|la|les|un|une|des|de|du|et|and|or|ou|in|en|à|au|aux)\b/g, "")
    .replace(/\b(и|в|на|с|по|из|для|это|как|что|но|от|до|не|он|она|они|его|её|их|был|быть|о|к|за)\b/g, "")
    .replace(/(^|\s)(في|من|إلى|على|مع|هذا|هذه|التي|الذي|وهو|أن|عن|لا|ما|هو|هي|كان|ذلك|بين|عند|أو|ثم)(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface TitleParts {
  section: string;
  pageName: string;
  full: string;
}

function splitTitleParts(title: string): TitleParts {
  const separators = [" - ", " – ", " — ", " | "];
  let bestIdx = -1;
  let bestSepLen = 0;

  for (const sep of separators) {
    const idx = title.indexOf(sep);
    if (idx > 0 && idx < title.length - sep.length) {
      if (bestIdx === -1) {
        bestIdx = idx;
        bestSepLen = sep.length;
      }
      break;
    }
  }

  if (bestIdx > 0) {
    const section = title.substring(0, bestIdx).trim();
    const rest = title.substring(bestIdx + bestSepLen).trim();
    if (section.split(/\s+/).length <= 5) {
      return { section, pageName: rest, full: title };
    }
  }
  return { section: "", pageName: title.trim(), full: title };
}

function wordSetSimilarity(a: string, b: string): number {
  const aNorm = normalizeTitle(a);
  const bNorm = normalizeTitle(b);
  if (aNorm === bNorm) return 1.0;
  if (!aNorm || !bNorm) return 0;

  const aWords = aNorm.split(" ").filter(w => w.length > 1);
  const bWordsSet = new Set(bNorm.split(" ").filter(w => w.length > 1));
  if (aWords.length === 0 || bWordsSet.size === 0) return 0;

  let intersection = 0;
  for (const w of aWords) {
    if (bWordsSet.has(w)) intersection++;
  }
  return intersection / (aWords.length + bWordsSet.size - intersection);
}

function titleSimilarity(a: string, b: string): number {
  const aNorm = normalizeTitle(a);
  const bNorm = normalizeTitle(b);

  if (aNorm === bNorm) return 1.0;
  if (!aNorm || !bNorm) return 0;

  const aWords = aNorm.split(" ").filter(w => w.length > 1);
  const bWordsSet = new Set(bNorm.split(" ").filter(w => w.length > 1));

  if (aWords.length === 0 || bWordsSet.size === 0) return 0;

  let intersection = 0;
  for (const w of aWords) {
    if (bWordsSet.has(w)) intersection++;
  }

  const jaccard = intersection / (aWords.length + bWordsSet.size - intersection);

  const containsBonus = (aNorm.includes(bNorm) || bNorm.includes(aNorm)) ? 0.15 : 0;

  return Math.min(jaccard + containsBonus, 1.0);
}

// ---- Semantic title matching (multilingual embeddings) ----
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_BATCH_SIZE = 2048;
const EMBED_TOTAL_CAP = 50000;
const EMBED_CACHE_MAX = 50000;
const EMBED_PRICE_PER_M_TOKENS = 0.02;
const titleEmbeddingCache = new Map<string, number[]>();
let _embedClient: OpenAI | null = null;
let _embedClientChecked = false;

function getEmbedClient(): OpenAI | null {
  if (_embedClientChecked) return _embedClient;
  _embedClientChecked = true;
  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) {
    log(`  [embed] OPENAI_API_KEY missing — semantic title matching disabled`);
    return null;
  }
  _embedClient = new OpenAI({
    apiKey,
    ...(process.env.OPENAI_API_KEY ? {} : { baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL }),
  });
  return _embedClient;
}

export function isSemanticEnabled(): boolean {
  if (process.env.LINGUAMAP_DISABLE_SEMANTIC === "1") return false;
  return !!(process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
}

export async function embedTitles(
  texts: string[],
  signal?: AbortSignal,
): Promise<{ map: Map<string, number[]>; tokensUsed: number }> {
  const map = new Map<string, number[]>();
  const uniq = Array.from(new Set(texts.map(t => t?.trim()).filter((t): t is string => !!t && t.length > 0)));
  const need: string[] = [];
  for (const t of uniq) {
    const cached = titleEmbeddingCache.get(t);
    if (cached) map.set(t, cached);
    else need.push(t);
  }
  if (need.length === 0) return { map, tokensUsed: 0 };
  const client = getEmbedClient();
  if (!client) return { map, tokensUsed: 0 };

  let totalTokens = 0;
  for (let i = 0; i < need.length; i += EMBED_BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = need.slice(i, i + EMBED_BATCH_SIZE);
    let attempt = 0;
    let success = false;
    while (attempt < 2 && !success) {
      try {
        const resp = await client.embeddings.create({ model: EMBED_MODEL, input: batch });
        for (let k = 0; k < batch.length; k++) {
          const vec = resp.data[k]?.embedding;
          if (vec && Array.isArray(vec)) {
            // LRU eviction: if at cap, drop oldest entry (Map preserves insertion order)
            if (titleEmbeddingCache.size >= EMBED_CACHE_MAX && !titleEmbeddingCache.has(batch[k])) {
              const firstKey = titleEmbeddingCache.keys().next().value;
              if (firstKey !== undefined) titleEmbeddingCache.delete(firstKey);
            }
            titleEmbeddingCache.set(batch[k], vec);
            map.set(batch[k], vec);
          }
        }
        totalTokens += resp.usage?.total_tokens || 0;
        success = true;
      } catch (e: any) {
        attempt++;
        if (attempt >= 2) {
          log(`  [embed] batch failed after retry: ${e?.message || e}`);
          break;
        }
        await abortAwareSleep(500, signal);
      }
    }
  }
  return { map, tokensUsed: totalTokens };
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function matchByTitleSemantic(
  sourceEmbedding: number[],
  inventory: CrawlInventory,
  minCosine: number = 0.55,
  allowedRoots?: string[],
  refDepths?: number[],
  sourceSegments?: Set<string>,
  disableSegmentRail: boolean = false,
): TitleMatchResult | null {
  if (!inventory.titleEmbeddings || inventory.titleEmbeddings.size === 0) return null;

  const minDepth = refDepths && refDepths.length > 0 ? Math.min(...refDepths) - 2 : 0;
  const maxDepth = refDepths && refDepths.length > 0 ? Math.max(...refDepths) + 2 : Infinity;

  let bestUrl: string | null = null;
  let bestSim = minCosine;
  let secondBestSim = 0;
  const scored: Array<{ url: string; sim: number }> = [];

  inventory.titleIndex.forEach((pageTitle, url) => {
    if (allowedRoots && allowedRoots.length > 0) {
      try {
        const urlPath = new URL(url).pathname.toLowerCase();
        if (!allowedRoots.some(r => urlPath.startsWith(r.toLowerCase()))) return;
      } catch { return; }
    }
    if (refDepths && refDepths.length > 0) {
      try {
        const urlParts = new URL(url).pathname.split("/").filter(Boolean);
        if (urlParts.length < minDepth || urlParts.length > maxDepth) return;
      } catch { return; }
    }
    const vec = inventory.titleEmbeddings!.get(pageTitle);
    if (!vec) return;
    const sim = cosineSimilarity(sourceEmbedding, vec);
    scored.push({ url, sim });
    if (sim > bestSim) {
      secondBestSim = bestSim;
      bestSim = sim;
      bestUrl = url;
    } else if (sim > secondBestSim) {
      secondBestSim = sim;
    }
  });

  if (!bestUrl) return null;

  const confidenceFor = (s: number) => Math.min(Math.round(70 + s * 25), 95);

  const gap = bestSim - secondBestSim;
  if (gap < 0.03 && bestSim < 0.85) {
    if (sourceSegments && sourceSegments.size > 0) {
      const close = scored.filter(s => s.sim >= bestSim - 0.03);
      if (close.length >= 2) {
        let bestPathScore = -1, bestPathUrl: string | null = null, pathTied = 0;
        for (const { url } of close) {
          try {
            const urlSegs = new Set(new URL(url).pathname.split("/").filter(Boolean).map(s => normalizeSegment(s)));
            let shared = 0;
            for (const s of sourceSegments) if (urlSegs.has(s)) shared++;
            if (shared > bestPathScore) { bestPathScore = shared; bestPathUrl = url; pathTied = 1; }
            else if (shared === bestPathScore) pathTied++;
          } catch {}
        }
        if (pathTied === 1 && bestPathUrl && bestPathScore > 0) {
          log(`    Semantic match DISAMBIGUATED (path segments): cos=${bestSim.toFixed(3)} -> ${bestPathUrl} (${bestPathScore} shared segs)`);
          return {
            url: bestPathUrl,
            confidence: confidenceFor(bestSim),
            method: "title-semantic+disambig",
            similarity: bestSim,
          };
        }
      }
    }
    log(`    Semantic match REJECTED (ambiguous): best=${bestSim.toFixed(3)} second=${secondBestSim.toFixed(3)} gap=${gap.toFixed(3)}`);
    return null;
  }

  if (sourceSegments && sourceSegments.size > 0 && !disableSegmentRail) {
    const allNonLatin = Array.from(sourceSegments).every(seg => /[^\x00-\x7F]/.test(seg));
    if (!allNonLatin) {
      try {
        const matchParts = new URL(bestUrl).pathname.split("/").filter(Boolean);
        const matchNorms = matchParts.map(p => normalizeSegment(p));
        let shared = 0;
        for (const seg of matchNorms) if (sourceSegments.has(seg)) shared++;
        if (shared === 0 && matchNorms.length > 2 && bestSim < 0.65) {
          log(`    Semantic match REJECTED (no shared segments AND cos<0.65): "${bestUrl}" cos=${bestSim.toFixed(3)}`);
          return null;
        }
      } catch {
        return null;
      }
    }
  }

  return {
    url: bestUrl,
    confidence: confidenceFor(bestSim),
    method: "title-semantic",
    similarity: bestSim,
  };
}


async function translateWithGTX(text: string, source: string, target: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  const { signal: combined, cleanup } = combineSignals(signal, 8000);
  try {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encoded}`;
    const resp = await fetch(url, {
      signal: combined,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    cleanup();
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const translated = data[0].map((s: any) => s[0]).join("");
      return translated || null;
    }
  } catch {
    cleanup();
  }
  return null;
}

async function translateText(text: string, targetLang: TargetLang, signal?: AbortSignal): Promise<string | null> {
  const cacheKey = `${text}|${targetLang}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey)!;

  const result = await translateWithGTX(text, "he", targetLang, signal);
  if (result) {
    translationCache.set(cacheKey, result);
    return result;
  }
  if (signal?.aborted) return null;

  await abortAwareSleep(500, signal);
  if (signal?.aborted) return null;
  const retry = await translateWithGTX(text, "he", targetLang, signal);
  if (retry) {
    translationCache.set(cacheKey, retry);
    return retry;
  }

  return null;
}

const TRANSLATE_CONCURRENCY = 5;

export async function batchTranslate(
  texts: string[],
  targetLang: TargetLang,
  dbStorage?: IStorage,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const uniqueSet = new Set(texts);
  const unique = Array.from(uniqueSet);

  let dbCache: Map<string, string> | null = null;
  if (dbStorage) {
    try {
      dbCache = await dbStorage.getCachedTranslations(targetLang);
    } catch {}
  }

  const needsTranslation: string[] = [];
  for (const text of unique) {
    const cacheKey = `${text}|${targetLang}`;
    if (translationCache.has(cacheKey)) {
      results.set(text, translationCache.get(cacheKey)!);
    } else if (dbCache && dbCache.has(text)) {
      const cached = dbCache.get(text)!;
      results.set(text, cached);
      translationCache.set(cacheKey, cached);
    } else {
      needsTranslation.push(text);
    }
  }

  if (results.size > 0 && needsTranslation.length > 0) {
    log(`    [translate] ${results.size} from cache, ${needsTranslation.length} need translation`);
  }

  if (needsTranslation.length === 0) {
    log(`    [translate] All ${results.size} titles found in cache`);
    return results;
  }

  let consecutiveFailures = 0;
  let totalProcessed = 0;
  const newTranslations: { sourceText: string; targetLang: string; translatedText: string }[] = [];

  for (let i = 0; i < needsTranslation.length; i += TRANSLATE_CONCURRENCY) {
    if (signal?.aborted) break;
    if (consecutiveFailures >= 8) {
      log(`    [translate] Too many consecutive failures, stopping. Translated ${results.size}/${unique.length}.`);
      break;
    }

    const batch = needsTranslation.slice(i, i + TRANSLATE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((text) => translateText(text, targetLang, signal).then((r) => ({ text, result: r })))
    );

    for (const { text, result } of batchResults) {
      if (result) {
        results.set(text, result);
        newTranslations.push({ sourceText: text, targetLang, translatedText: result });
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }
    }

    totalProcessed += batch.length;

    if (totalProcessed % 50 === 0 || i + TRANSLATE_CONCURRENCY >= needsTranslation.length) {
      log(`    [translate] Progress: ${results.size} translated, ${totalProcessed}/${needsTranslation.length} processed`);
    }

    await abortAwareSleep(200, signal);
  }

  if (dbStorage && newTranslations.length > 0) {
    try {
      await dbStorage.saveCachedTranslations(newTranslations);
      log(`    [translate] Saved ${newTranslations.length} new translations to persistent cache`);
    } catch (e: any) {
      log(`    [translate] Warning: Failed to save to DB cache: ${e?.message?.substring(0, 80)}`);
    }
  }

  return results;
}

export interface TitleMatchResult {
  url: string;
  confidence: number;
  method: string;
  similarity: number;
}

export function matchByTitle(
  translatedTitle: string,
  inventory: CrawlInventory,
  minSimilarity: number = 0.60,
  allowedRoots?: string[],
  refDepths?: number[],
  sourceSegments?: Set<string>,
  disableSegmentRail: boolean = false,
): TitleMatchResult | null {
  let bestMatch: TitleMatchResult | null = null;
  let bestSimilarity = minSimilarity;
  let secondBestSimilarity = 0;

  const minDepth = refDepths && refDepths.length > 0 ? Math.min(...refDepths) - 2 : 0;
  const maxDepth = refDepths && refDepths.length > 0 ? Math.max(...refDepths) + 2 : Infinity;

  const translatedParts = splitTitleParts(translatedTitle);
  const translatedSection = translatedParts.section ? normalizeTitle(translatedParts.section) : "";
  const hasSection = translatedSection.length > 0;

  inventory.titleIndex.forEach((pageTitle, url) => {
    if (allowedRoots && allowedRoots.length > 0) {
      try {
        const urlPath = new URL(url).pathname.toLowerCase();
        const matchesRoot = allowedRoots.some(root => urlPath.startsWith(root.toLowerCase()));
        if (!matchesRoot) return;
      } catch { return; }
    }

    if (refDepths && refDepths.length > 0) {
      try {
        const urlParts = new URL(url).pathname.split("/").filter(Boolean);
        if (urlParts.length < minDepth || urlParts.length > maxDepth) return;
      } catch { return; }
    }

    const baseSim = titleSimilarity(translatedTitle, pageTitle);

    let sectionBonus = 0;
    let usedSection = false;

    if (hasSection) {
      const targetParts = splitTitleParts(pageTitle);
      if (targetParts.section) {
        const sectionSim = wordSetSimilarity(translatedParts.section, targetParts.section);
        if (sectionSim >= 0.4) {
          const pageSim = wordSetSimilarity(translatedParts.pageName, targetParts.pageName);
          sectionBonus = pageSim * 0.1 + sectionSim * 0.05;
          usedSection = true;
        }
      }
    }

    const sim = Math.min(baseSim + sectionBonus, 1.0);

    if (sim > bestSimilarity) {
      secondBestSimilarity = bestSimilarity;
      bestSimilarity = sim;
      bestMatch = {
        url,
        confidence: Math.round(70 + sim * 20),
        method: usedSection ? "title-section-match" : "title-match",
        similarity: sim,
      };
    } else if (sim > secondBestSimilarity) {
      secondBestSimilarity = sim;
    }
  });

  const finalMatch = bestMatch as TitleMatchResult | null;
  if (finalMatch) {
    const gap = bestSimilarity - secondBestSimilarity;
    if (gap < 0.05 && bestSimilarity < 0.95) {
      if (sourceSegments && sourceSegments.size > 0) {
        const allMatches = Array.from(inventory.urls).filter(url => {
          const pageTitle = inventory.titleIndex.get(url);
          if (!pageTitle) return false;
          const sim = wordSetSimilarity(translatedTitle, pageTitle);
          return sim >= bestSimilarity - 0.05;
        });
        if (allMatches.length >= 2) {
          let bestPathScore = -1;
          let bestPathUrl: string | null = null;
          let pathTied = 0;
          for (const url of allMatches) {
            try {
              const urlSegs = new Set(new URL(url).pathname.split("/").filter(Boolean).map(s => normalizeSegment(s)));
              let shared = 0;
              for (const s of sourceSegments) { if (urlSegs.has(s)) shared++; }
              if (shared > bestPathScore) {
                bestPathScore = shared;
                bestPathUrl = url;
                pathTied = 1;
              } else if (shared === bestPathScore) {
                pathTied++;
              }
            } catch {}
          }
          if (pathTied === 1 && bestPathUrl && bestPathScore > 0) {
            log(`    Title match DISAMBIGUATED (path segments): "${translatedTitle}" -> ${bestPathUrl} (${bestPathScore} shared segs)`);
            return {
              url: bestPathUrl,
              confidence: 78,
              method: "title-disambig",
              similarity: bestSimilarity,
            };
          }
        }
      }
      log(`    Title match REJECTED (ambiguous): "${translatedTitle}" best=${bestSimilarity.toFixed(3)} second=${secondBestSimilarity.toFixed(3)} gap=${gap.toFixed(3)}`);
      return null;
    }

    if (sourceSegments && sourceSegments.size > 0 && !disableSegmentRail) {
      const allNonLatin = Array.from(sourceSegments).every(seg => /[^\x00-\x7F]/.test(seg));
      if (!allNonLatin) {
        try {
          const matchParts = new URL(finalMatch.url).pathname.split("/").filter(Boolean);
          const matchNorms = matchParts.map(p => normalizeSegment(p));
          let sharedSegments = 0;
          for (const seg of matchNorms) {
            if (sourceSegments.has(seg)) sharedSegments++;
          }
          if (sharedSegments === 0 && matchNorms.length > 2 && bestSimilarity < 0.75) {
            log(`    Title match REJECTED (no shared segments AND sim<0.75): "${translatedTitle}" -> ${finalMatch.url} (sim=${bestSimilarity.toFixed(3)})`);
            return null;
          }
        } catch {
          log(`    Title match REJECTED (URL parse error): "${translatedTitle}" -> ${finalMatch.url}`);
          return null;
        }
      }
    }
  }

  return finalMatch;
}

export async function titleMatchUnmatched(
  unmatchedRows: { rowIndex: number; title: string; sourceUrl: string; needs: Record<TargetLang, boolean> }[],
  inventories: Record<TargetLang, CrawlInventory | null>,
  dbStorage?: IStorage,
  allowedRoots?: Record<TargetLang, string[]>,
  refDepths?: Record<TargetLang, number[] | undefined>,
  knownUrls?: Record<TargetLang, Set<string>>,
  signal?: AbortSignal,
  crossScriptLangs?: Record<TargetLang, boolean>,
): Promise<Map<number, BatchMatchResult>> {
  const results = new Map<number, BatchMatchResult>();
  const langs: TargetLang[] = ["en", "fr", "ru", "ar"];
  const langNames: Record<TargetLang, string> = { en: "English", fr: "French", ru: "Russian", ar: "Arabic" };
  const isCrossScript: Record<TargetLang, boolean> = crossScriptLangs ?? { en: false, fr: false, ru: false, ar: false };

  if (unmatchedRows.length === 0) return results;

  const titles = unmatchedRows.map((r) => r.title).filter(Boolean);
  if (titles.length === 0) return results;

  const translations: Record<TargetLang, Map<string, string>> = { en: new Map(), fr: new Map(), ru: new Map(), ar: new Map() };

  for (const lang of langs) {
    const inv = inventories[lang];
    const roots = allowedRoots?.[lang];
    const titlesNeeded = unmatchedRows
      .filter(r => r.needs[lang] && inv && inv.titleIndex.size > 0 && roots && roots.length > 0)
      .map(r => r.title).filter(Boolean);
    if (titlesNeeded.length > 0) {
      if (signal?.aborted) break;
      log(`  Translating ${titlesNeeded.length} titles to ${langNames[lang]} for title matching...`);
      translations[lang] = await batchTranslate(titlesNeeded, lang, dbStorage, signal);
      log(`  Translated ${translations[lang].size} titles to ${langNames[lang]}`);
    }
  }

  // ---- Semantic embeddings prep (per-language; pivots through GTX translation) ----
  // Embed the GTX-translated source title and the inventory titles in the SAME
  // target language. Same-language cosine is far sharper than cross-lingual
  // HE↔target (which we measured at ~0.4 even for true matches).
  const translatedEmbeddings: Record<TargetLang, Map<string, number[]>> = {
    en: new Map(), fr: new Map(), ru: new Map(), ar: new Map(),
  };
  let semanticActive = false;
  let semanticTokens = 0;
  const semAcceptedByLang: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  const semAttemptedByLang: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  const semCosineSumByLang: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  let semRejectedThreshold = 0;
  if (!isSemanticEnabled()) {
    if (process.env.LINGUAMAP_DISABLE_SEMANTIC === "1") {
      log(`  Semantic title-match SKIPPED: LINGUAMAP_DISABLE_SEMANTIC=1`);
    } else {
      log(`  Semantic title-match SKIPPED: OPENAI_API_KEY not configured`);
    }
  } else {
    // Per-job guard: cap is on titles NEW to this run that we'd need to actually
    // embed (i.e., titles not already cached). Cached titles cost no API tokens
    // so they don't count toward the budget. This matches "per-job" semantics
    // in the common case (one job per server lifetime) without spuriously
    // suppressing later jobs in long-lived processes that have warm caches.
    let inventoryToEmbed = 0;
    let translatedToEmbed = 0;
    for (const lang of langs) {
      const inv = inventories[lang];
      if (inv && inv.titleIndex.size > 0) {
        for (const t of new Set(inv.titleIndex.values())) {
          if (t && !titleEmbeddingCache.has(t.trim())) inventoryToEmbed++;
        }
      }
      for (const t of new Set(Array.from(translations[lang].values()).filter(Boolean))) {
        if (!titleEmbeddingCache.has(t.trim())) translatedToEmbed++;
      }
    }
    if (inventoryToEmbed + translatedToEmbed > EMBED_TOTAL_CAP) {
      log(`  Semantic title-match SKIPPED: would embed ${inventoryToEmbed + translatedToEmbed} new titles this job (cap ${EMBED_TOTAL_CAP})`);
    } else {
      for (const lang of langs) {
        if (signal?.aborted) break;
        const inv = inventories[lang];
        const roots = allowedRoots?.[lang];
        if (!inv || inv.titleIndex.size === 0 || !roots || roots.length === 0) continue;
        if (!unmatchedRows.some(r => r.needs[lang])) continue;
        if (translations[lang].size === 0) continue;

        if (!inv.titleEmbeddings || inv.titleEmbeddings.size === 0) {
          const titles = Array.from(new Set(Array.from(inv.titleIndex.values())));
          const invRes = await embedTitles(titles, signal);
          inv.titleEmbeddings = invRes.map;
          semanticTokens += invRes.tokensUsed;
          log(`  Semantic title-match: ${invRes.map.size} ${langNames[lang]} inventory titles embedded`);
        }

        const translatedTexts = Array.from(new Set(Array.from(translations[lang].values()).filter(Boolean)));
        if (translatedTexts.length > 0) {
          const tRes = await embedTitles(translatedTexts, signal);
          translatedEmbeddings[lang] = tRes.map;
          semanticTokens += tRes.tokensUsed;
          log(`  Semantic title-match: ${tRes.map.size} translated ${langNames[lang]} source titles embedded`);
          if (tRes.map.size > 0) semanticActive = true;
        }
      }
    }
  }

  let titleMatches = 0;
  let semanticAccepted = 0;
  let semanticAttempted = 0;
  let rejected = { ambiguous: 0, noSegments: 0, depth: 0, crossValidation: 0, knownUrl: 0 };
  const usedUrls: Record<TargetLang, Set<string>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };

  const candidates: { rowIndex: number; sourceUrl: string; matches: Record<TargetLang, TitleMatchResult | null> }[] = [];

  for (const row of unmatchedRows) {
    if (!row.title) continue;

    const sourceSegments = new Set<string>();
    try {
      const srcParts = new URL(row.sourceUrl).pathname.split("/").filter(Boolean);
      for (const p of srcParts) {
        const norm = normalizeSegment(p);
        if (norm && norm !== "pages" && norm !== "default.aspx" && norm.length > 3) {
          sourceSegments.add(norm);
        }
      }
    } catch {}

    const rowMatches: Record<TargetLang, TitleMatchResult | null> = { en: null, fr: null, ru: null, ar: null };
    let hasMatch = false;

    for (const lang of langs) {
      const inv = inventories[lang];
      const roots = allowedRoots?.[lang];
      if (row.needs[lang] && inv && inv.titleIndex.size > 0 && roots && roots.length > 0) {
        const translated = translations[lang].get(row.title);
        if (translated) {
          const minSim = (lang === "ru" || lang === "ar") ? 0.55 : 0.60;
          rowMatches[lang] = matchByTitle(translated, inv, minSim, roots, refDepths?.[lang], sourceSegments, isCrossScript[lang]);
          if (rowMatches[lang]) hasMatch = true;
        }

        // Semantic fallback: only if cheap pass produced nothing for this row+lang.
        // Pivot through the GTX translation so cosine is same-language (sharp),
        // not cross-lingual HE↔target (much weaker).
        if (!rowMatches[lang] && semanticActive && inv.titleEmbeddings && inv.titleEmbeddings.size > 0 && translated) {
          const trKey = translated.trim();
          const trEmb = translatedEmbeddings[lang].get(trKey);
          if (trEmb) {
            semanticAttempted++;
            semAttemptedByLang[lang]++;
            const minCos = (lang === "ru" || lang === "ar") ? 0.55 : 0.58;
            const semMatch = matchByTitleSemantic(trEmb, inv, minCos, roots, refDepths?.[lang], sourceSegments, isCrossScript[lang]);
            if (semMatch) {
              // Note: semanticAccepted is NOT incremented here — only after the
              // match survives cross-validation, knownUrl filter, and dedup at
              // setResultMatch time below.
              semCosineSumByLang[lang] += semMatch.similarity;
              rowMatches[lang] = semMatch;
              hasMatch = true;
            } else {
              semRejectedThreshold++;
            }
          }
        }
      }
    }

    if (hasMatch) {
      candidates.push({ rowIndex: row.rowIndex, sourceUrl: row.sourceUrl, matches: rowMatches });
    }
  }

  // Process cheap-bearing candidates BEFORE semantic-only candidates so that
  // semantic-only matches can never claim a URL that a cheap match needs (which
  // would silently regress the cheap match via the usedUrls/knownUrls dedup).
  const hasCheapMatch = (c: typeof candidates[number]) =>
    langs.some(l => c.matches[l] && !((c.matches[l]!.method || "").includes("semantic")));
  candidates.sort((a, b) => {
    const aCheap = hasCheapMatch(a) ? 1 : 0;
    const bCheap = hasCheapMatch(b) ? 1 : 0;
    if (aCheap !== bCheap) return bCheap - aCheap;
    const aConf = Math.max(...langs.map(l => a.matches[l]?.similarity || 0));
    const bConf = Math.max(...langs.map(l => b.matches[l]?.similarity || 0));
    return bConf - aConf;
  });

  for (const candidate of candidates) {
    const m = { ...candidate.matches };

    const matchedLangs = langs.filter(l => m[l] !== null);
    if (matchedLangs.length >= 2) {
      const tails: Record<string, string[]> = {};
      for (const l of matchedLangs) {
        try {
          tails[l] = new URL(m[l]!.url).pathname.split("/").filter(Boolean).slice(-2).map(p => normalizeSegment(p));
        } catch { tails[l] = []; }
      }

      const latinLangs = new Set<TargetLang>(["en", "fr"]);
      const scriptCompatible = (a: TargetLang, b: TargetLang) => latinLangs.has(a) && latinLangs.has(b);

      for (let i = 0; i < matchedLangs.length; i++) {
        for (let j = i + 1; j < matchedLangs.length; j++) {
          const la = matchedLangs[i], lb = matchedLangs[j];
          if (!m[la] || !m[lb]) continue;
          if (!scriptCompatible(la, lb)) continue;
          let tailOverlap = 0;
          for (const seg of tails[la]) {
            if (tails[lb].some(f => f === seg || (seg.length > 4 && f.includes(seg)) || (f.length > 4 && seg.includes(f)))) {
              tailOverlap++;
            }
          }
          if (tailOverlap === 0 && tails[la].length > 0 && tails[lb].length > 0) {
            // Protect cheap-pass matches from being nulled by a newly-added
            // semantic candidate. Pre-semantic, the cheap match would have
            // survived alone; adding semantic must not regress it.
            const aSem = (m[la]!.method || "").includes("semantic");
            const bSem = (m[lb]!.method || "").includes("semantic");
            if (aSem && !bSem) {
              log(`    Cross-validation REJECTED ${la.toUpperCase()} (semantic) vs ${lb.toUpperCase()} (cheap kept): "${m[la]!.url}"`);
              m[la] = null;
              rejected.crossValidation++;
            } else if (bSem && !aSem) {
              log(`    Cross-validation REJECTED ${lb.toUpperCase()} (semantic) vs ${la.toUpperCase()} (cheap kept): "${m[lb]!.url}"`);
              m[lb] = null;
              rejected.crossValidation++;
            } else {
              log(`    Cross-validation REJECTED BOTH: ${la.toUpperCase()} "${m[la]!.url}" vs ${lb.toUpperCase()} "${m[lb]!.url}" (no tail overlap)`);
              m[la] = null;
              m[lb] = null;
              rejected.crossValidation += 2;
            }
          }
        }
      }

      for (const l of matchedLangs) {
        if (!m[l]) continue;
        const isSem = (m[l]!.method || "").includes("semantic");
        // Cheap matches that survived their single-lang threshold (e.g. RU>=0.55)
        // should not be nulled merely because semantic added another language.
        // Apply the stricter paired threshold only to semantic candidates and to
        // cheap matches that were already paired with another cheap match.
        const otherCheapPresent = matchedLangs.some(o => o !== l && m[o] && !((m[o]!.method || "").includes("semantic")));
        const shouldGate = isSem || (!isSem && otherCheapPresent);
        if (shouldGate && m[l]!.similarity < 0.60) {
          log(`    Paired ${l.toUpperCase()} REJECTED (similarity ${m[l]!.similarity.toFixed(3)} < 0.60, method=${m[l]!.method}): "${m[l]!.url}"`);
          m[l] = null;
          rejected.crossValidation++;
        }
      }
    } else if (matchedLangs.length === 1) {
      const l = matchedLangs[0];
      const minSim = (l === "ru" || l === "ar") ? 0.55 : 0.65;
      if (m[l]!.similarity < minSim) {
        log(`    Single-lang ${l.toUpperCase()} REJECTED (similarity ${m[l]!.similarity.toFixed(3)} < ${minSim}): "${m[l]!.url}"`);
        m[l] = null;
        rejected.crossValidation++;
      }
    }

    const result = emptyBatchResult();
    let hasResult = false;

    for (const lang of langs) {
      const match = m[lang];
      if (match && !usedUrls[lang].has(match.url)) {
        if (knownUrls && knownUrls[lang].has(match.url)) {
          log(`    Title match REJECTED (already known ${lang.toUpperCase()} ref): ${match.url}`);
          rejected.knownUrl++;
        } else {
          setResultMatch(result, lang, match.url, match.confidence, match.method);
          usedUrls[lang].add(match.url);
          hasResult = true;
          if ((match.method || "").includes("semantic")) {
            semanticAccepted++;
            semAcceptedByLang[lang]++;
          }
        }
      }
    }

    if (hasResult) {
      results.set(candidate.rowIndex, result);
      titleMatches++;
    }
  }

  const usedSummary = langs.map(l => `${usedUrls[l].size} ${l.toUpperCase()}`).join(", ");
  log(`  Title matching found ${titleMatches} new matches (${usedSummary} unique URLs)`);
  log(`  Title rejections: ambiguous=${rejected.ambiguous}, noSharedSegments=${rejected.noSegments}, crossValidation=${rejected.crossValidation}, knownUrl=${rejected.knownUrl}`);
  if (semanticActive) {
    const cost = (semanticTokens / 1_000_000) * EMBED_PRICE_PER_M_TOKENS;
    const perLang = langs
      .filter(l => semAttemptedByLang[l] > 0)
      .map(l => {
        const accepted = semAcceptedByLang[l];
        const attempted = semAttemptedByLang[l];
        const meanCos = accepted > 0 ? (semCosineSumByLang[l] / accepted).toFixed(3) : "n/a";
        return `${l.toUpperCase()}=${accepted}/${attempted}(meanCos=${meanCos})`;
      })
      .join(", ");
    const semRejectedDownstream = semanticAttempted - semRejectedThreshold - semanticAccepted;
    log(`  Semantic title-match: ${semanticAccepted} accepted out of ${semanticAttempted} attempted [${perLang || "none"}] rejected: threshold/ambiguity=${semRejectedThreshold}, downstream(crossVal/known/dedup)=${Math.max(0, semRejectedDownstream)} (~${semanticTokens} tokens, ~$${cost.toFixed(4)})`);
  }
  return results;
}

const AI_BATCH_SIZE = 15;
const AI_CONCURRENCY = 2;

interface AiMatchInput {
  rowIndex: number;
  title: string;
  sourceUrl: string;
  needs: Record<TargetLang, boolean>;
}

interface AiSuggestion {
  sourceUrl: string;
  englishUrl?: string | null;
  frenchUrl?: string | null;
  russianUrl?: string | null;
  arabicUrl?: string | null;
  reasoning: string;
}

export async function aiMatchUnmatched(
  unmatchedRows: AiMatchInput[],
  inventories: Record<TargetLang, CrawlInventory | null>,
  tabPatterns: TabPatterns,
  matchedExamples: { sourceUrl: string; enUrl?: string; frUrl?: string; ruUrl?: string; arUrl?: string }[],
  allTranslations: Record<TargetLang, Map<string, string>>,
  knownUrls: Record<TargetLang, Set<string>>,
  signal?: AbortSignal,
): Promise<Map<number, BatchMatchResult>> {
  const results = new Map<number, BatchMatchResult>();
  const langs: TargetLang[] = ["en", "fr", "ru", "ar"];
  const langLabels: Record<TargetLang, string> = { en: "English", fr: "French", ru: "Russian", ar: "Arabic" };
  const suggestionKeys: Record<TargetLang, keyof AiSuggestion> = { en: "englishUrl", fr: "frenchUrl", ru: "russianUrl", ar: "arabicUrl" };

  if (unmatchedRows.length === 0) return results;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    ...(process.env.OPENAI_API_KEY ? {} : { baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL }),
  });

  // Model selection: gpt-4.1-mini gives us a 1M-token context, removing the
  // 128K bottleneck that was causing every batch to fail with "context length
  // exceeded". Used on both the API-key path and the integrations path.
  const chatModel = "gpt-4.1-mini";

  const TITLE_TRUNC = 120;
  const truncTitle = (t: string) =>
    t && t.length > TITLE_TRUNC ? t.slice(0, TITLE_TRUNC) + "…" : t;

  // Compact JSON-line entries: {i, url, title}. Smaller than the previous
  // `"url  |  title"` text form once titles are truncated, and the prompt
  // can reference fields by name without a magic separator.
  const inventoryUrls: Record<TargetLang, string[]> = { en: [], fr: [], ru: [], ar: [] };
  const inventoryEntries: Record<TargetLang, string[]> = { en: [], fr: [], ru: [], ar: [] };
  const activeLangs: TargetLang[] = [];
  for (const l of langs) {
    inventoryUrls[l] = inventories[l] ? Array.from(inventories[l]!.urls) : [];
    if (inventories[l]) {
      const titleIdx = inventories[l]!.titleIndex;
      inventoryEntries[l] = inventoryUrls[l].map((u, i) => {
        const t = titleIdx.get(u);
        const obj: { i: number; url: string; title?: string } = { i, url: u };
        if (t) obj.title = truncTitle(t);
        return JSON.stringify(obj);
      });
    }
    if (inventoryUrls[l].length > 0) activeLangs.push(l);
  }

  // Per-language section buckets: section-segment -> indices into
  // inventoryUrls[l]. The "section" is the first path segment after the
  // language target root, normalized. URLs whose section can't be inferred
  // (e.g. URLs at the section root, or URLs whose path doesn't actually
  // start with the learned root) go into the "__no_section__" bucket and
  // are always available as a fallback.
  const NO_SECTION = "__no_section__";
  const sectionBuckets: Record<TargetLang, Map<string, number[]>> = { en: new Map(), fr: new Map(), ru: new Map(), ar: new Map() };
  for (const l of activeLangs) {
    const targetRoot = langRoot(tabPatterns, l);
    const targetRootNorm = targetRoot.map(s => normalizeSegment(s));
    for (let i = 0; i < inventoryUrls[l].length; i++) {
      const u = inventoryUrls[l][i];
      let bucket = NO_SECTION;
      try {
        const parts = new URL(u).pathname.split("/").filter(Boolean);
        const cleanParts = stripSuffix(parts);
        // Only strip the root if the URL actually starts with it; otherwise
        // we'd misread a deeper segment as the section.
        let after: string[] = cleanParts;
        if (targetRootNorm.length > 0) {
          let matches = true;
          for (let r = 0; r < targetRootNorm.length; r++) {
            if (normalizeSegment(cleanParts[r] || "") !== targetRootNorm[r]) { matches = false; break; }
          }
          after = matches ? cleanParts.slice(targetRootNorm.length) : [];
        }
        if (after.length > 0) {
          const seg = normalizeSegment(after[0]);
          if (seg && seg !== "pages" && seg !== "default.aspx" && seg.length > 2) {
            bucket = seg;
          }
        }
      } catch {}
      const arr = sectionBuckets[l].get(bucket) || [];
      arr.push(i);
      sectionBuckets[l].set(bucket, arr);
    }
  }

  // For a given source section (a Hebrew slug), figure out what target-lang
  // section bucket(s) to look in. We try the segment-translation map first
  // (Hebrew→target word) and also the literal source section as a fallback
  // (sections often share the same key across languages on this site).
  const targetSectionsForSource = (srcSection: string, l: TargetLang): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (s: string | null | undefined) => {
      if (!s) return;
      const k = normalizeSegment(s);
      if (k && !seen.has(k)) { seen.add(k); out.push(k); }
    };
    const segs = tabPatterns.segmentMap.get(l);
    if (segs && segs.has(srcSection)) push(segs.get(srcSection));
    push(srcSection);
    return out;
  };

  // Filter examples to those that include at least one active target language,
  // so single-language runs aren't distracted by EN/FR pairs.
  const activeLangSet = new Set(activeLangs);
  const exampleHasActive = (ex: typeof matchedExamples[number]) =>
    (activeLangSet.has("en" as TargetLang) && !!ex.enUrl) ||
    (activeLangSet.has("fr" as TargetLang) && !!ex.frUrl) ||
    (activeLangSet.has("ru" as TargetLang) && !!ex.ruUrl) ||
    (activeLangSet.has("ar" as TargetLang) && !!ex.arUrl);
  const filteredExamples = matchedExamples.filter(exampleHasActive).slice(0, 8);
  const exampleLines = filteredExamples.map(ex => {
    const parts = [`  Source: ${ex.sourceUrl}`];
    if (ex.enUrl && activeLangSet.has("en" as TargetLang)) parts.push(`  English: ${ex.enUrl}`);
    if (ex.frUrl && activeLangSet.has("fr" as TargetLang)) parts.push(`  French: ${ex.frUrl}`);
    if (ex.ruUrl && activeLangSet.has("ru" as TargetLang)) parts.push(`  Russian: ${ex.ruUrl}`);
    if (ex.arUrl && activeLangSet.has("ar" as TargetLang)) parts.push(`  Arabic: ${ex.arUrl}`);
    return parts.join("\n");
  }).join("\n---\n");

  const patternContext: string[] = [];
  for (const l of activeLangs) {
    const r = langRoot(tabPatterns, l);
    const sr = langSrcRoot(tabPatterns, l);
    if (r.length > 0) {
      patternContext.push(`${langLabels[l]} section root path: /${r.join("/")}/`);
      patternContext.push(`Hebrew source root path for ${langLabels[l]}: /${sr.join("/")}/`);
    }
    if (tabPatterns.segmentMap.get(l)?.size) {
      const segs = Array.from(tabPatterns.segmentMap.get(l)!.entries()).slice(0, 15);
      patternContext.push(`Known Hebrew→${langLabels[l]} segment translations: ${segs.map(([k,v]) => `${k}→${v}`).join(", ")}`);
    }
  }

  // Group unmatched rows by their source section (the first path segment of
  // the Hebrew source URL after the source root). Batches are then formed
  // *within* each section, so each prompt sees only the inventory slice that
  // belongs to that section. This sharply reduces prompt size and stops the
  // model from being distracted by cross-section URLs.
  //
  // Per-language source roots can differ when root learning produced
  // different roots for different langs. For each row, try every active
  // lang's source root and pick the one that actually prefixes the URL with
  // the longest match. Fall back to NO_SECTION if none match.
  const activeSrcRoots = activeLangs.map(l => langSrcRoot(tabPatterns, l));
  const sectionForSource = (sourceUrl: string): string => {
    let best: string | null = null;
    let bestLen = -1;
    let pathParts: string[] | null = null;
    try {
      pathParts = stripSuffix(new URL(sourceUrl).pathname.split("/").filter(Boolean));
    } catch { return NO_SECTION; }
    for (const root of activeSrcRoots) {
      const rootNorm = root.map(s => normalizeSegment(s));
      // Verify this root is actually a prefix of the URL.
      if (rootNorm.length > pathParts.length) continue;
      let matches = true;
      for (let r = 0; r < rootNorm.length; r++) {
        if (normalizeSegment(pathParts[r] || "") !== rootNorm[r]) { matches = false; break; }
      }
      if (!matches) continue;
      if (rootNorm.length <= bestLen) continue;
      const seg = getSourceSectionSegment(sourceUrl, root);
      if (seg) { best = seg; bestLen = rootNorm.length; }
    }
    // Fallback: try with empty root so we still extract *some* segment for
    // URLs whose root isn't yet learned.
    if (!best) {
      const seg = getSourceSectionSegment(sourceUrl, []);
      if (seg) best = seg;
    }
    return best || NO_SECTION;
  };

  const rowsBySection = new Map<string, AiMatchInput[]>();
  for (const row of unmatchedRows) {
    const seg = sectionForSource(row.sourceUrl);
    const arr = rowsBySection.get(seg) || [];
    arr.push(row);
    rowsBySection.set(seg, arr);
  }

  type SectionBatch = { section: string; rows: AiMatchInput[] };
  const batches: SectionBatch[] = [];
  // Iterate sections in deterministic order (largest first, then alpha) so logs are stable
  const sectionOrder = Array.from(rowsBySection.entries())
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [section, rows] of sectionOrder) {
    for (let i = 0; i < rows.length; i += AI_BATCH_SIZE) {
      batches.push({ section, rows: rows.slice(i, i + AI_BATCH_SIZE) });
    }
  }

  const invSummary = langs.map(l => `${inventoryUrls[l].length} ${l.toUpperCase()}`).join(", ");
  log(`  AI matching: ${unmatchedRows.length} unmatched URLs in ${batches.length} batches across ${rowsBySection.size} sections using ${chatModel} (inventory: ${invSummary})`);

  const usedUrls: Record<TargetLang, Set<string>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };
  for (const l of langs) { for (const u of knownUrls[l]) usedUrls[l].add(u); }
  let aiMatches = 0;
  let consecutiveAuthFailures = 0;
  let consecutiveZeroBatches = 0;
  const ZERO_BATCH_EARLY_EXIT = 5;

  // Helper: detect a section's generic index page (the model loves to fall
  // back to these). Used to keep a small reminder block of taken index pages
  // even after we filter used URLs out of the visible inventory.
  const isDefaultIndex = (u: string) => {
    let path = u;
    try { path = new URL(u).pathname; }
    catch { path = u.split("#")[0].split("?")[0]; }
    return /\/(default\.aspx|index\.aspx)$/i.test(path) || /\/Pages\/?$/i.test(path);
  };

  // Per-language AI telemetry: counts attempts, accepts, and each rejection reason
  // so prompt tuning is measurable across runs.
  const aiStats: Record<TargetLang, { attempted: number; accepted: number; rejNull: number; rejNotInInv: number; rejAlreadyUsed: number; rejOutsideRoot: number; rejSection: number }> = {
    en: { attempted: 0, accepted: 0, rejNull: 0, rejNotInInv: 0, rejAlreadyUsed: 0, rejOutsideRoot: 0, rejSection: 0 },
    fr: { attempted: 0, accepted: 0, rejNull: 0, rejNotInInv: 0, rejAlreadyUsed: 0, rejOutsideRoot: 0, rejSection: 0 },
    ru: { attempted: 0, accepted: 0, rejNull: 0, rejNotInInv: 0, rejAlreadyUsed: 0, rejOutsideRoot: 0, rejSection: 0 },
    ar: { attempted: 0, accepted: 0, rejNull: 0, rejNotInInv: 0, rejAlreadyUsed: 0, rejOutsideRoot: 0, rejSection: 0 },
  };

  const langNeedLabel: Record<TargetLang, string> = { en: "English URL", fr: "French URL", ru: "Russian URL", ar: "Arabic URL" };

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    if (signal?.aborted) {
      log(`  AI matching ABORTED by user before batch ${batchIdx + 1}/${batches.length}`);
      break;
    }
    const batchEntry = batches[batchIdx];
    const batch = batchEntry.rows;
    const batchSection = batchEntry.section;

    const urlsBlock = batch.map(row => {
      const parts = [`- Source URL: ${row.sourceUrl}`];
      parts.push(`  Title (Hebrew): ${row.title || "N/A"}`);
      for (const l of langs) {
        const t = allTranslations[l].get(row.title);
        if (t) parts.push(`  Title (${langLabels[l]} translation): ${t}`);
        if (row.needs[l]) parts.push(`  Needs: ${langNeedLabel[l]}`);
      }
      return parts.join("\n");
    }).join("\n\n");

    // Build the visible inventory from this batch's section bucket only.
    // For each language we look up the section's URLs (mapping the source
    // section through the segment translation map when present), then drop
    // any already-used URLs. If the section bucket is empty for a language,
    // we fall back to the full pool so we never hand the model an empty
    // candidate list.
    const INVENTORY_PER_LANG_CAP = 2000;
    const inventoryBlocks: string[] = [];
    const visibleStats: { lang: TargetLang; total: number; available: number; shown: number; scoped: boolean }[] = [];
    for (const l of activeLangs) {
      const totalCount = inventoryUrls[l].length;

      // Pick candidate indices for this section; fall back to all indices if
      // the section bucket is missing or empty after used-URL filtering.
      let candidateIndices: number[] = [];
      let scoped = false;
      if (batchSection !== NO_SECTION) {
        const targetSecs = targetSectionsForSource(batchSection, l);
        const seen = new Set<number>();
        for (const ts of targetSecs) {
          const arr = sectionBuckets[l].get(ts);
          if (!arr) continue;
          for (const idx of arr) if (!seen.has(idx)) { seen.add(idx); candidateIndices.push(idx); }
        }
        if (candidateIndices.length > 0) scoped = true;
      }
      if (candidateIndices.length === 0) {
        candidateIndices = Array.from({ length: inventoryUrls[l].length }, (_, i) => i);
      }

      const available: string[] = [];
      for (const i of candidateIndices) {
        if (!usedUrls[l].has(inventoryUrls[l][i])) {
          available.push(inventoryEntries[l][i]);
        }
      }
      const availableCount = available.length;
      const shown = available.length <= INVENTORY_PER_LANG_CAP
        ? available
        : available.slice(0, INVENTORY_PER_LANG_CAP);
      const truncatedNote = available.length > shown.length
        ? `\n... (${available.length - shown.length} more available; not shown to keep prompt small)`
        : "";
      const scopeLabel = scoped ? `section "${batchSection}"` : `all sections (no scoped candidates for "${batchSection}")`;
      const list = shown.length > 0
        ? shown.join("\n") + truncatedNote
        : `(no ${langLabels[l]} URLs left in ${scopeLabel} — all candidates already matched)`;
      inventoryBlocks.push(`AVAILABLE ${langLabels[l].toUpperCase()} URLs in ${scopeLabel} (${availableCount} unused of ${totalCount} total). Each line is a JSON object {"i":<index>,"url":"<url>","title":"<page title>"}. When you choose, return the value of the "url" field verbatim:\n${list}`);
      visibleStats.push({ lang: l, total: totalCount, available: availableCount, shown: shown.length, scoped });
    }

    // Tiny reminder block: only the generic /Pages/default.aspx-style index
    // pages that have already been taken. The model has a strong bias toward
    // proposing these as a fallback, so keep them explicitly visible even
    // though we removed them from the inventory above.
    const usedDefaultsBlock = activeLangs.map(l => {
      const taken = Array.from(usedUrls[l]).filter(isDefaultIndex);
      if (taken.length === 0) return "";
      return `ALREADY-TAKEN ${langLabels[l].toUpperCase()} INDEX PAGES (do NOT propose these — match to a more specific page or return null):\n${taken.join("\n")}`;
    }).filter(Boolean).join("\n\n");

    // Russian and Arabic addendum: their URL slugs are Latin transliterations
    // of Hebrew words, not Russian/Arabic. Slug similarity is misleading; the
    // "title" field of each inventory entry is the only reliable signal.
    const needsTransliterationNote = activeLangs.includes("ru" as TargetLang) || activeLangs.includes("ar" as TargetLang);
    const transliterationNote = needsTransliterationNote
      ? `\n\nIMPORTANT FOR RUSSIAN/ARABIC:
- The Russian and Arabic URL slugs are LATIN transliterations of Hebrew words (e.g. "HarvotBarzelOuestions", "MankIDudQ"), NOT Russian or Arabic words.
- Do NOT try to read meaning from the URL slug for these languages — it carries almost no signal.
- Use the "title" field of each inventory entry as your PRIMARY (and effectively only) decision signal. The title is in Cyrillic/Arabic and is the human-readable description of the page.
- Do NOT invent URLs by completing transliteration patterns you see in the inventory. Copy the "url" field verbatim from an entry in the inventory list.`
      : "";

    const langListText = activeLangs.map(l => langLabels[l]).join(", ");
    const jsonFields = activeLangs.map(l => `- "${suggestionKeys[l]}": the matching ${langLabels[l]} URL from the inventory, or null if no confident match`).join("\n");

    const systemPrompt = `You are a URL matching expert for a multilingual government website. Your task is to find the correct ${langListText} equivalent pages for Hebrew source URLs.

CRITICAL RULES:
1. You may ONLY select URLs from the provided AVAILABLE inventory lists below. Each inventory line is a JSON object with fields {i, url, title}. Return the value of the "url" field verbatim — never invent or construct URLs. If a URL you want is not character-for-character present as the "url" field of some entry in the AVAILABLE list, return null.
2. If you cannot find a confident match, return null for that language. Leaving a cell blank is ALWAYS better than assigning a wrong URL.
3. Each target URL should only be used ONCE across all matches in this batch. Do not assign the same target URL to multiple source URLs.
4. The AVAILABLE lists already exclude URLs that have been matched in earlier batches — every URL in those lists is fresh and unused. Do not propose a URL that is not in the AVAILABLE list.
5. PRIMARY signal: compare the source page title (translated) against the "title" field of each candidate inventory entry. A match should make sense as a same-topic page in the other language. URL slug similarity is only a secondary hint.
6. The chosen URL MUST start with the target language section root path shown in WEBSITE STRUCTURE. Cross-section matches (e.g. picking a payroll page for a contact-us source) are forbidden.
7. If the source title is a generic page like "contact us", "home", or "about", only match it to a clearly equivalent target page (same generic concept). When in doubt, return null.
8. NEVER fall back to a section's index page (URLs ending in "/Pages/default.aspx", "/default.aspx", or "/Pages/") just because nothing more specific looks plausible. Index pages should only be returned when the SOURCE itself is clearly the section's index page (matching title like "default" / "home" / the section name). Otherwise return null. The ALREADY-TAKEN INDEX PAGES block lists index pages that have already been used — never propose those.${transliterationNote}

WEBSITE STRUCTURE:
${patternContext.join("\n")}

EXAMPLES OF CORRECTLY MATCHED PAIRS:
${exampleLines || "(no examples available)"}

${usedDefaultsBlock}`;

    const userPrompt = `Find the matching ${langListText} URLs for each of these Hebrew source URLs.

UNMATCHED SOURCE URLs:
${urlsBlock}

${inventoryBlocks.join("\n\n")}

For each source URL, respond with a JSON array of objects. Each object must have:
- "sourceUrl": the original Hebrew source URL
${jsonFields}
- "reasoning": a brief explanation of why you matched these URLs (or why no match was found)

Return ONLY the JSON array, no other text.`;

    try {
      let content: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (signal?.aborted) { content = null; break; }
          const response = await openai.chat.completions.create({
            model: chatModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
            max_completion_tokens: 8192,
          }, { signal });
          content = response.choices[0]?.message?.content || null;
          consecutiveAuthFailures = 0;
          break;
        } catch (retryErr: any) {
          const status = retryErr?.status || retryErr?.response?.status;
          if (status === 401 || status === 429) {
            const delay = (attempt + 1) * 2000;
            log(`    AI batch ${batchIdx + 1}/${batches.length}: ${status} error, retrying in ${delay}ms (attempt ${attempt + 1}/3)`);
            await abortAwareSleep(delay, signal);
            if (signal?.aborted) { content = null; break; }
            continue;
          }
          throw retryErr;
        }
      }

      if (!content) {
        log(`    AI batch ${batchIdx + 1}/${batches.length}: failed after 3 retries (likely auth/rate-limit issue)`);
        consecutiveAuthFailures++;
        consecutiveZeroBatches = 0;
        if (consecutiveAuthFailures >= 3) {
          log(`  AI matching ABORTED: ${consecutiveAuthFailures} consecutive batches failed with auth errors. Skipping remaining ${batches.length - batchIdx - 1} batches.`);
          break;
        }
        continue;
      }

      let suggestions: AiSuggestion[] = [];
      try {
        const parsed = JSON.parse(content);
        suggestions = Array.isArray(parsed) ? parsed : (parsed.matches || parsed.results || parsed.urls || []);
      } catch {
        log(`    AI batch ${batchIdx + 1}/${batches.length}: failed to parse response`);
        consecutiveZeroBatches = 0;
        continue;
      }

      let batchMatches = 0;

      // Count attempts up-front from the batch (not from model suggestions),
      // so rows the model omits entirely are still counted. Track handled
      // (sourceUrl, lang) keys; anything left unhandled at batch end is a null reject.
      const handled: Record<TargetLang, Set<string>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };
      for (const r of batch) {
        for (const l of langs) {
          if (r.needs[l]) aiStats[l].attempted++;
        }
      }

      for (const suggestion of suggestions) {
        if (!suggestion.sourceUrl) continue;

        const row = batch.find(r => r.sourceUrl === suggestion.sourceUrl);
        if (!row) continue;

        const result = emptyBatchResult();
        let hasMatch = false;

        for (const l of langs) {
          let suggestedUrl = suggestion[suggestionKeys[l]] as string | null | undefined;
          if (suggestedUrl && typeof suggestedUrl === "string") {
            // Defensive: legacy "url  |  title" format and the new
            // {"i","url","title"} JSON line both occasionally get echoed back
            // as a whole line; pull the URL out either way.
            const trimmed = suggestedUrl.trim();
            if (trimmed.startsWith("{")) {
              try {
                const parsedEntry = JSON.parse(trimmed);
                if (parsedEntry && typeof parsedEntry.url === "string") suggestedUrl = parsedEntry.url;
              } catch {}
            }
            const sepIdx = (suggestedUrl as string).indexOf("  |  ");
            if (sepIdx > 0) suggestedUrl = (suggestedUrl as string).slice(0, sepIdx).trim();
          }
          if (row.needs[l]) {
            handled[l].add(row.sourceUrl);
            if (!suggestedUrl) {
              aiStats[l].rejNull++;
              continue;
            }
            const rootPath = langRoot(tabPatterns, l);
            const rootBase = rootPath.length > 0 ? "/" + rootPath.join("/") : "";
            const rootWithSlash = rootBase ? rootBase + "/" : "";
            let outsideRoot = false;
            if (rootBase) {
              try {
                const parsed = new URL(suggestedUrl);
                const p = parsed.pathname.toLowerCase().replace(/\/+$/, "");
                const base = rootBase.toLowerCase().replace(/\/+$/, "");
                if (p !== base && !parsed.pathname.toLowerCase().startsWith(rootWithSlash.toLowerCase())) {
                  outsideRoot = true;
                }
              } catch { outsideRoot = true; }
            }
            if (outsideRoot) {
              log(`    AI REJECTED (outside ${l.toUpperCase()} root ${rootBase}): ${suggestedUrl}`);
              aiStats[l].rejOutsideRoot++;
            } else if (!inventories[l]?.urls.has(suggestedUrl)) {
              log(`    AI REJECTED (not in inventory): ${l.toUpperCase()} ${suggestedUrl}`);
              aiStats[l].rejNotInInv++;
            } else if (usedUrls[l].has(suggestedUrl)) {
              log(`    AI REJECTED (already used): ${l.toUpperCase()} ${suggestedUrl}`);
              aiStats[l].rejAlreadyUsed++;
            } else if (!validateSectionContext(suggestedUrl, row.sourceUrl, l, tabPatterns)) {
              log(`    AI REJECTED (section/category mismatch with source): ${l.toUpperCase()} ${suggestedUrl} ⟵ ${row.sourceUrl}`);
              aiStats[l].rejSection++;
            } else {
              setResultMatch(result, l, suggestedUrl, 82, "ai-match");
              usedUrls[l].add(suggestedUrl);
              aiStats[l].accepted++;
              hasMatch = true;
            }
          }
        }

        if (hasMatch) {
          results.set(row.rowIndex, result);
          batchMatches++;
          if (suggestion.reasoning) {
            const matchSummary = langs.map(l => `${l.toUpperCase()}:${getResultUrl(result, l) || "null"}`).join(" ");
            log(`    AI match: ${row.sourceUrl} -> ${matchSummary} (${suggestion.reasoning})`);
          }
        }
      }

      // Any (row, lang) pair we needed but the model never returned in its
      // suggestions counts as a null reject (silent omission).
      for (const r of batch) {
        for (const l of langs) {
          if (r.needs[l] && !handled[l].has(r.sourceUrl)) {
            aiStats[l].rejNull++;
          }
        }
      }

      aiMatches += batchMatches;
      const visibleStr = visibleStats.map(v => `${v.lang.toUpperCase()}:${v.shown}/${v.available}${v.scoped ? "" : "*"}`).join(" ");
      log(`  AI batch ${batchIdx + 1}/${batches.length} [${batchSection}] (${chatModel}): ${batchMatches} matches from ${batch.length} URLs (visible inventory ${visibleStr})`);

      if (batchMatches === 0) {
        consecutiveZeroBatches++;
        // Guard: don't early-exit too soon. Require we've already worked
        // through at least 1/3 of the planned batches (or 8, whichever is
        // larger), so a slow start on a long run doesn't bail prematurely.
        const minBatchesBeforeEarlyExit = Math.max(8, Math.floor(batches.length / 3));
        if (
          consecutiveZeroBatches >= ZERO_BATCH_EARLY_EXIT &&
          batchIdx + 1 >= minBatchesBeforeEarlyExit &&
          batchIdx < batches.length - 1
        ) {
          const remaining = batches.length - batchIdx - 1;
          log(`  AI matching EARLY EXIT: ${consecutiveZeroBatches} consecutive batches yielded 0 matches after ${batchIdx + 1}/${batches.length} batches. Skipping remaining ${remaining} batches.`);
          break;
        }
      } else {
        consecutiveZeroBatches = 0;
      }
    } catch (error: any) {
      const status = error?.status || error?.response?.status;
      const msg = String(error?.message || "");
      const errCode = error?.code || error?.error?.code || error?.response?.data?.error?.code;
      const errType = error?.type || error?.error?.type || error?.response?.data?.error?.type;
      const errMsg = error?.error?.message || error?.response?.data?.error?.message || "";
      const ctxRegex = /context length|maximum context|too many tokens|context_length|context window/i;
      const isContextLen = status === 400 && (
        ctxRegex.test(msg) ||
        ctxRegex.test(String(errMsg)) ||
        String(errCode || "") === "context_length_exceeded" ||
        String(errType || "") === "context_length_exceeded"
      );
      if (isContextLen) {
        log(`  AI batch ${batchIdx + 1}/${batches.length} [${batchSection}] CONTEXT-LENGTH error (${chatModel}): ${msg.substring(0, 200)}`);
        // Treat context-length failures as "0-match completed" batches so the
        // existing early-exit kicks in if they keep happening — otherwise a
        // mis-sized prompt would silently burn through every batch.
        consecutiveZeroBatches++;
        const minBatchesBeforeEarlyExit = Math.max(8, Math.floor(batches.length / 3));
        if (
          consecutiveZeroBatches >= ZERO_BATCH_EARLY_EXIT &&
          batchIdx + 1 >= minBatchesBeforeEarlyExit &&
          batchIdx < batches.length - 1
        ) {
          const remaining = batches.length - batchIdx - 1;
          log(`  AI matching EARLY EXIT: ${consecutiveZeroBatches} consecutive batches yielded 0 matches (incl. context-length errors) after ${batchIdx + 1}/${batches.length}. Skipping remaining ${remaining} batches.`);
          break;
        }
      } else {
        log(`  AI batch ${batchIdx + 1}/${batches.length} [${batchSection}] error: ${msg.substring(0, 200)}`);
        consecutiveZeroBatches = 0;
      }
    }

    if (batchIdx < batches.length - 1) {
      await abortAwareSleep(500, signal);
    }
  }

  log(`  AI matching complete: ${aiMatches} total matches from ${unmatchedRows.length} unmatched URLs`);
  for (const l of activeLangs) {
    const s = aiStats[l];
    if (s.attempted === 0) continue;
    const accountedFor = s.accepted + s.rejNull + s.rejNotInInv + s.rejAlreadyUsed + s.rejOutsideRoot + s.rejSection;
    const invariantNote = accountedFor === s.attempted ? "" : ` [WARN: counter drift, accounted=${accountedFor} != attempted]`;
    log(`    AI ${l.toUpperCase()} stats: attempted=${s.attempted} accepted=${s.accepted} | rejected: null=${s.rejNull}, not-in-inv=${s.rejNotInInv}, already-used=${s.rejAlreadyUsed}, outside-root=${s.rejOutsideRoot}, section-mismatch=${s.rejSection}${invariantNote}`);
  }
  return results;
}
