import { log } from "./index";
import * as cheerio from "cheerio";

export interface MatchScore {
  total: number;
  slugScore: number;
  titleScore: number;
  structureScore: number;
  method: "slug" | "meta" | "structure" | "mixed" | "pattern";
}

export interface TabPatterns {
  enRoot: string[];
  frRoot: string[];
  enSrcRoot: string[];
  frSrcRoot: string[];
  enCrawlScope: string[];
  frCrawlScope: string[];
  segmentMap: Map<string, Map<string, string>>;
  patternValidated: { en: boolean; fr: boolean };
}

const urlExistenceCache = new Map<string, boolean>();
const HEAD_CONCURRENCY = 50;
const HEAD_TIMEOUT = 3000;

export function clearCaches() {
  urlExistenceCache.clear();
}

async function headCheck(url: string): Promise<boolean> {
  if (urlExistenceCache.has(url)) return urlExistenceCache.get(url)!;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEAD_TIMEOUT);
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinguaMap/1.0; URL Mapper Bot)",
      },
      redirect: "follow",
    });
    clearTimeout(timeout);
    const exists = response.ok;
    urlExistenceCache.set(url, exists);
    return exists;
  } catch {
    urlExistenceCache.set(url, false);
    return false;
  }
}

export async function batchHeadCheck(urls: string[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const uncached: string[] = [];
  for (const url of urls) {
    if (urlExistenceCache.has(url)) {
      results.set(url, urlExistenceCache.get(url)!);
    } else {
      uncached.push(url);
    }
  }
  for (let i = 0; i < uncached.length; i += HEAD_CONCURRENCY) {
    const batch = uncached.slice(i, i + HEAD_CONCURRENCY);
    const checks = await Promise.all(
      batch.map(async (url) => ({ url, exists: await headCheck(url) }))
    );
    for (const { url, exists } of checks) {
      results.set(url, exists);
    }
  }
  return results;
}

export interface RootMapping {
  sourceRoot: string[];
  targetRoot: string[];
}

export function learnTabPatterns(
  rows: { sourceUrl: string; enUrl?: string; frUrl?: string }[]
): TabPatterns {
  const segmentMap = new Map<string, Map<string, string>>();
  segmentMap.set("en", new Map());
  segmentMap.set("fr", new Map());

  const enPairs: { src: string[]; tgt: string[] }[] = [];
  const frPairs: { src: string[]; tgt: string[] }[] = [];

  for (const row of rows) {
    try {
      const sourceParsed = new URL(row.sourceUrl);
      const sourceParts = sourceParsed.pathname.split("/").filter(Boolean);
      if (sourceParts.length === 0) continue;

      if (row.enUrl) {
        try {
          const enParsed = new URL(row.enUrl);
          if (enParsed.origin === sourceParsed.origin) {
            const enParts = enParsed.pathname.split("/").filter(Boolean);
            enPairs.push({ src: stripSuffix(sourceParts), tgt: stripSuffix(enParts) });
          }
        } catch {}
      }

      if (row.frUrl) {
        try {
          const frParsed = new URL(row.frUrl);
          if (frParsed.origin === sourceParsed.origin) {
            const frParts = frParsed.pathname.split("/").filter(Boolean);
            frPairs.push({ src: stripSuffix(sourceParts), tgt: stripSuffix(frParts) });
          }
        } catch {}
      }
    } catch {}
  }

  const enMapping = computeRootMapping(enPairs, segmentMap.get("en")!);
  const frMapping = computeRootMapping(frPairs, segmentMap.get("fr")!);

  const enRoot = enMapping ? enMapping.targetRoot : [];
  const frRoot = frMapping ? frMapping.targetRoot : [];
  const enSrcRoot = enMapping ? enMapping.sourceRoot : [];
  const frSrcRoot = frMapping ? frMapping.sourceRoot : [];

  let enCrawlScope = enPairs.length > 0
    ? findCommonPrefix(enPairs.map((p) => p.tgt))
    : enRoot;
  let frCrawlScope = frPairs.length > 0
    ? findCommonPrefix(frPairs.map((p) => p.tgt))
    : frRoot;
  if (enCrawlScope.length > 0 && normalizeSegment(enCrawlScope[enCrawlScope.length - 1]) === "pages") {
    enCrawlScope = enCrawlScope.slice(0, -1);
  }
  if (frCrawlScope.length > 0 && normalizeSegment(frCrawlScope[frCrawlScope.length - 1]) === "pages") {
    frCrawlScope = frCrawlScope.slice(0, -1);
  }

  log(`Tab patterns learned:`);
  if (enMapping) log(`  EN: /${enSrcRoot.join("/") || "*"}/ → /${enRoot.join("/")}/`);
  if (frMapping) log(`  FR: /${frSrcRoot.join("/") || "*"}/ → /${frRoot.join("/")}/`);
  if (enCrawlScope.length > enRoot.length) log(`  EN crawl scope: /${enCrawlScope.join("/")}/`);
  if (frCrawlScope.length > frRoot.length) log(`  FR crawl scope: /${frCrawlScope.join("/")}/`);
  const enSeg = segmentMap.get("en")?.size || 0;
  const frSeg = segmentMap.get("fr")?.size || 0;
  log(`  Segment translations: ${enSeg} EN, ${frSeg} FR`);

  return {
    enRoot, frRoot,
    enSrcRoot: enSrcRoot,
    frSrcRoot: frSrcRoot,
    enCrawlScope,
    frCrawlScope,
    segmentMap,
    patternValidated: { en: false, fr: false },
  };
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
): RootMapping | null {
  if (pairs.length === 0) return null;

  const srcRoots: string[][] = [];
  const tgtRoots: string[][] = [];

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

    srcRoots.push(src.slice(0, srcRootLen));
    tgtRoots.push(tgt.slice(0, tgtRootLen));

    for (let i = 0; i < srcRootLen && i < tgtRootLen; i++) {
      const sNorm = normalizeSegment(src[i]);
      const tNorm = normalizeSegment(tgt[i]);
      if (sNorm !== tNorm) {
        segMap.set(sNorm, tgt[i]);
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

  return {
    sourceRoot: commonSrcRoot,
    targetRoot: commonTgtRoot,
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
  lang: "en" | "fr",
  tabPatterns: TabPatterns
): string | null {
  try {
    const parsed = new URL(sourceUrl);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length === 0) return null;

    const targetRoot = lang === "en" ? tabPatterns.enRoot : tabPatterns.frRoot;
    const sourceRoot = lang === "en" ? tabPatterns.enSrcRoot : tabPatterns.frSrcRoot;
    if (targetRoot.length === 0) return null;

    const segments = tabPatterns.segmentMap.get(lang);

    const cleanParts = stripSuffix(pathParts);

    let remaining: string[];
    if (sourceRoot.length > 0) {
      let matchLen = 0;
      for (let i = 0; i < sourceRoot.length && i < cleanParts.length; i++) {
        if (normalizeSegment(cleanParts[i]) === normalizeSegment(sourceRoot[i])) {
          matchLen++;
        } else {
          break;
        }
      }
      remaining = cleanParts.slice(matchLen);
    } else {
      remaining = cleanParts;
    }

    const translatedParts = remaining.map((part) => {
      if (!segments) return part;
      const norm = normalizeSegment(part);
      return segments.has(norm) ? segments.get(norm)! : part;
    });

    return parsed.origin + "/" + [...targetRoot, ...translatedParts].join("/");
  } catch {}

  return null;
}

export async function validatePatterns(
  tabPatterns: TabPatterns,
  sampleUrls: { sourceUrl: string; lang: "en" | "fr" }[]
): Promise<{ en: number; fr: number }> {
  const enSamples: string[] = [];
  const frSamples: string[] = [];

  for (const sample of sampleUrls) {
    const candidate = constructTargetUrl(sample.sourceUrl, sample.lang, tabPatterns);
    if (candidate) {
      if (sample.lang === "en") enSamples.push(candidate);
      else frSamples.push(candidate);
    }
  }

  const allUrls = [...enSamples, ...frSamples];
  if (allUrls.length === 0) return { en: 0, fr: 0 };

  const existence = await batchHeadCheck(allUrls);

  let enValid = 0;
  for (const url of enSamples) {
    if (existence.get(url)) enValid++;
  }
  let frValid = 0;
  for (const url of frSamples) {
    if (existence.get(url)) frValid++;
  }

  const enRate = enSamples.length > 0 ? enValid / enSamples.length : 0;
  const frRate = frSamples.length > 0 ? frValid / frSamples.length : 0;

  log(`  Pattern validation: EN ${enValid}/${enSamples.length} (${(enRate * 100).toFixed(0)}%), FR ${frValid}/${frSamples.length} (${(frRate * 100).toFixed(0)}%)`);

  tabPatterns.patternValidated.en = enRate >= 0.3;
  tabPatterns.patternValidated.fr = frRate >= 0.3;

  return { en: enValid, fr: frValid };
}

export interface BatchMatchResult {
  enUrl: string | null;
  frUrl: string | null;
  confidenceEn: number | null;
  confidenceFr: number | null;
  matchMethodEn: string | null;
  matchMethodFr: string | null;
}

export function batchConstructUrls(
  sourceUrls: { sourceUrl: string; needsEn: boolean; needsFr: boolean; index: number }[],
  tabPatterns: TabPatterns
): Map<number, BatchMatchResult> {
  const results = new Map<number, BatchMatchResult>();

  for (const item of sourceUrls) {
    const result: BatchMatchResult = {
      enUrl: null,
      frUrl: null,
      confidenceEn: null,
      confidenceFr: null,
      matchMethodEn: null,
      matchMethodFr: null,
    };

    if (item.needsEn && tabPatterns.patternValidated.en) {
      const enUrl = constructTargetUrl(item.sourceUrl, "en", tabPatterns);
      if (enUrl) {
        result.enUrl = enUrl;
        result.confidenceEn = 90;
        result.matchMethodEn = "pattern";
      }
    }

    if (item.needsFr && tabPatterns.patternValidated.fr) {
      const frUrl = constructTargetUrl(item.sourceUrl, "fr", tabPatterns);
      if (frUrl) {
        result.frUrl = frUrl;
        result.confidenceFr = 90;
        result.matchMethodFr = "pattern";
      }
    }

    results.set(item.index, result);
  }

  return results;
}

const CRAWL_CONCURRENCY = 30;
const CRAWL_TIMEOUT = 8000;
const CRAWL_MAX_PAGES = 500;

export interface CrawlInventory {
  urls: Set<string>;
  normalizedIndex: Map<string, string>;
  tailIndex: Map<string, string[]>;
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

async function fetchPage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CRAWL_TIMEOUT);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinguaMap/1.0; URL Mapper Bot)",
        "Accept": "text/html",
      },
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;
    return await response.text();
  } catch {
    return null;
  }
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
  onProgress?: (crawled: number, queued: number) => void
): Promise<CrawlInventory> {
  const inventory: CrawlInventory = {
    urls: new Set(),
    normalizedIndex: new Map(),
    tailIndex: new Map(),
  };

  const scopePrefix = "/" + rootPath.join("/");
  const startUrl = origin + scopePrefix + "/";

  const visited = new Set<string>();
  const queue: string[] = [startUrl];

  if (rootPath.length > 0) {
    const defaultUrl = origin + scopePrefix + "/Pages/default.aspx";
    queue.push(defaultUrl);
  }

  let crawled = 0;

  while (queue.length > 0 && crawled < CRAWL_MAX_PAGES) {
    const batch = queue.splice(0, CRAWL_CONCURRENCY);
    const toFetch = batch.filter((url) => !visited.has(url));
    for (const url of toFetch) visited.add(url);

    if (toFetch.length === 0) continue;

    const results = await Promise.all(
      toFetch.map(async (url) => {
        const html = await fetchPage(url);
        return { url, html };
      })
    );

    for (const { url, html } of results) {
      crawled++;

      addToInventory(inventory, url);

      if (html) {
        const links = extractLinks(html, url, scopePrefix);
        for (const link of links) {
          addToInventory(inventory, link);
          if (!visited.has(link)) {
            queue.push(link);
          }
        }
      }
    }

    if (onProgress) {
      onProgress(crawled, queue.length);
    }
  }

  return inventory;
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
}

export function matchAgainstInventory(
  sourceUrl: string,
  lang: "en" | "fr",
  tabPatterns: TabPatterns,
  inventory: CrawlInventory
): { url: string; confidence: number; method: string } | null {
  const constructedUrl = constructTargetUrl(sourceUrl, lang, tabPatterns);
  if (constructedUrl && inventory.urls.has(constructedUrl)) {
    return { url: constructedUrl, confidence: 95, method: "pattern+crawl" };
  }

  if (constructedUrl) {
    const constructedNorm = normalizeUrlPath(constructedUrl);
    const inventoryUrl = inventory.normalizedIndex.get(constructedNorm);
    if (inventoryUrl) {
      return { url: inventoryUrl, confidence: 93, method: "pattern+crawl-norm" };
    }
  }

  try {
    const parsed = new URL(sourceUrl);
    const srcParts = parsed.pathname.split("/").filter(Boolean);
    const cleanSrc = stripSuffix(srcParts);

    const sourceRoot = lang === "en" ? tabPatterns.enSrcRoot : tabPatterns.frSrcRoot;

    let srcTailParts: string[];
    if (sourceRoot.length > 0) {
      let matchLen = 0;
      for (let i = 0; i < sourceRoot.length && i < cleanSrc.length; i++) {
        if (normalizeSegment(cleanSrc[i]) === normalizeSegment(sourceRoot[i])) {
          matchLen++;
        } else break;
      }
      srcTailParts = cleanSrc.slice(matchLen);
    } else {
      srcTailParts = cleanSrc;
    }

    if (srcTailParts.length >= 1) {
      const lastSeg = normalizeSegment(srcTailParts[srcTailParts.length - 1]);
      if (lastSeg && lastSeg !== "pages") {
        const tail1 = lastSeg;
        const candidates = inventory.tailIndex.get(tail1) || [];
        if (candidates.length === 1) {
          return { url: candidates[0], confidence: 85, method: "crawl-tail" };
        }

        if (srcTailParts.length >= 2 && candidates.length > 1) {
          const tail2 = srcTailParts.slice(-2).map((p) => normalizeSegment(p)).join("/");
          const candidates2 = inventory.tailIndex.get(tail2) || [];
          if (candidates2.length === 1) {
            return { url: candidates2[0], confidence: 88, method: "crawl-tail2" };
          }
        }
      }
    }

    if (srcTailParts.length >= 2) {
      const segments = tabPatterns.segmentMap.get(lang);
      const translatedTail = srcTailParts.map((p) => {
        const norm = normalizeSegment(p);
        if (segments && segments.has(norm)) return normalizeSegment(segments.get(norm)!);
        return norm;
      });

      for (let tailLen = Math.min(translatedTail.length, 3); tailLen >= 1; tailLen--) {
        const tailKey = translatedTail.slice(-tailLen).join("/");
        const candidates = inventory.tailIndex.get(tailKey) || [];
        if (candidates.length === 1) {
          return { url: candidates[0], confidence: 86, method: "crawl-translated-tail" };
        }
      }
    }
  } catch {}

  if (constructedUrl) {
    urlExistenceCache.set(constructedUrl, false);
  }

  return null;
}
