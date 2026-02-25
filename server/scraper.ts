import { log } from "./index";
import * as cheerio from "cheerio";
import type { IStorage } from "./storage";
import Anthropic from "@anthropic-ai/sdk";

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
const translationCache = new Map<string, string>();
const HEAD_CONCURRENCY = 50;
const HEAD_TIMEOUT = 3000;

export function clearCaches() {
  urlExistenceCache.clear();
}

export function clearAllCaches() {
  urlExistenceCache.clear();
  translationCache.clear();
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
  titleIndex: Map<string, string>;
  lastSegWordIndex: Map<string, Set<string>>;
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

      if (html) {
        addToInventory(inventory, url);

        const $ = cheerio.load(html);
        const pageTitle = $("title").first().text().trim();
        if (pageTitle) {
          const lowerTitle = pageTitle.toLowerCase();
          const isErrorPage = lowerTitle.includes("page not found") ||
            lowerTitle.includes("404 -") ||
            lowerTitle.includes("שגיאה") ||
            lowerTitle.includes("הדף לא נמצא");
          if (isErrorPage) {
            removeFromInventory(inventory, url);
          } else {
            inventory.titleIndex.set(url, pageTitle);
          }
        }

        const links = extractLinks(html, url, scopePrefix);
        for (const link of links) {
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
  lang: "en" | "fr",
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

    if (score >= 0.5 && (!best || score > best.score)) {
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
  lang: "en" | "fr",
  tabPatterns: TabPatterns
): boolean {
  const sourceRoot = lang === "en" ? tabPatterns.enSrcRoot : tabPatterns.frSrcRoot;
  const targetRoot = lang === "en" ? tabPatterns.enRoot : tabPatterns.frRoot;
  const segments = tabPatterns.segmentMap.get(lang);

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

export function matchAgainstInventory(
  sourceUrl: string,
  lang: "en" | "fr",
  tabPatterns: TabPatterns,
  inventory: CrawlInventory
): { url: string; confidence: number; method: string } | null {
  const constructedUrl = constructTargetUrl(sourceUrl, lang, tabPatterns);
  const sourceRoot = lang === "en" ? tabPatterns.enSrcRoot : tabPatterns.frSrcRoot;
  const targetRoot = lang === "en" ? tabPatterns.enRoot : tabPatterns.frRoot;

  if (constructedUrl) {
    if (!validateDepthMatch(sourceUrl, constructedUrl, sourceRoot, targetRoot)) {
      log(`    REJECTED (parent-only, depth mismatch): ${sourceUrl} -> ${constructedUrl}`);
    } else if (inventory.urls.has(constructedUrl)) {
      return { url: constructedUrl, confidence: 95, method: "pattern+crawl" };
    } else {
      const constructedNorm = normalizeUrlPath(constructedUrl);
      const inventoryUrl = inventory.normalizedIndex.get(constructedNorm);
      if (inventoryUrl) {
        return { url: inventoryUrl, confidence: 93, method: "pattern+crawl-norm" };
      }
    }
  }

  try {
    const parsed = new URL(sourceUrl);
    const srcParts = parsed.pathname.split("/").filter(Boolean);
    const cleanSrc = stripSuffix(srcParts);

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

        const sectionFiltered = candidates.filter(c => validateSectionContext(c, sourceUrl, lang, tabPatterns));

        if (sectionFiltered.length === 1) {
          if (validateDepthMatch(sourceUrl, sectionFiltered[0], sourceRoot, targetRoot)) {
            return { url: sectionFiltered[0], confidence: 85, method: "crawl-tail" };
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
        const sectionFiltered = candidates.filter(c => validateSectionContext(c, sourceUrl, lang, tabPatterns));
        if (sectionFiltered.length === 1) {
          if (validateDepthMatch(sourceUrl, sectionFiltered[0], sourceRoot, targetRoot)) {
            return { url: sectionFiltered[0], confidence: 86, method: "crawl-translated-tail" };
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

  if (constructedUrl) {
    urlExistenceCache.set(constructedUrl, false);
  }

  return null;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[-–—_|:]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(the|a|an|le|la|les|un|une|des|de|du|et|and|or|ou|in|en|à|au|aux)\b/g, "")
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


async function translateWithGTX(text: string, source: string, target: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const encoded = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encoded}`;
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const translated = data[0].map((s: any) => s[0]).join("");
      return translated || null;
    }
  } catch {}
  return null;
}

async function translateText(text: string, targetLang: "en" | "fr"): Promise<string | null> {
  const cacheKey = `${text}|${targetLang}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey)!;

  const result = await translateWithGTX(text, "he", targetLang);
  if (result) {
    translationCache.set(cacheKey, result);
    return result;
  }

  await new Promise((r) => setTimeout(r, 500));
  const retry = await translateWithGTX(text, "he", targetLang);
  if (retry) {
    translationCache.set(cacheKey, retry);
    return retry;
  }

  return null;
}

const TRANSLATE_CONCURRENCY = 5;

export async function batchTranslate(
  texts: string[],
  targetLang: "en" | "fr",
  dbStorage?: IStorage
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
    if (consecutiveFailures >= 8) {
      log(`    [translate] Too many consecutive failures, stopping. Translated ${results.size}/${unique.length}.`);
      break;
    }

    const batch = needsTranslation.slice(i, i + TRANSLATE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((text) => translateText(text, targetLang).then((r) => ({ text, result: r })))
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

    await new Promise((r) => setTimeout(r, 200));
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
  minSimilarity: number = 0.85,
  allowedRoots?: string[],
  refDepths?: number[],
  sourceSegments?: Set<string>,
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
      log(`    Title match REJECTED (ambiguous): "${translatedTitle}" best=${bestSimilarity.toFixed(3)} second=${secondBestSimilarity.toFixed(3)} gap=${gap.toFixed(3)}`);
      return null;
    }

    if (!sourceSegments || sourceSegments.size === 0) {
      log(`    Title match REJECTED (no source segments to validate): "${translatedTitle}" -> ${finalMatch.url}`);
      return null;
    }

    try {
      const matchParts = new URL(finalMatch.url).pathname.split("/").filter(Boolean);
      const matchNorms = matchParts.map(p => normalizeSegment(p));
      let sharedSegments = 0;
      for (const seg of matchNorms) {
        if (sourceSegments.has(seg)) sharedSegments++;
      }
      if (sharedSegments === 0 && matchNorms.length > 2) {
        log(`    Title match REJECTED (no shared segments): "${translatedTitle}" -> ${finalMatch.url}`);
        return null;
      }
    } catch {
      log(`    Title match REJECTED (URL parse error): "${translatedTitle}" -> ${finalMatch.url}`);
      return null;
    }
  }

  return finalMatch;
}

export async function titleMatchUnmatched(
  unmatchedRows: { rowIndex: number; title: string; sourceUrl: string; needsEn: boolean; needsFr: boolean }[],
  enInventory: CrawlInventory | null,
  frInventory: CrawlInventory | null,
  dbStorage?: IStorage,
  enAllowedRoots?: string[],
  frAllowedRoots?: string[],
  enRefDepths?: number[],
  frRefDepths?: number[],
  knownEnUrls?: Set<string>,
  knownFrUrls?: Set<string>,
): Promise<Map<number, BatchMatchResult>> {
  const results = new Map<number, BatchMatchResult>();

  if (unmatchedRows.length === 0) return results;

  const titles = unmatchedRows.map((r) => r.title).filter(Boolean);
  if (titles.length === 0) return results;

  const enTitlesNeeded = unmatchedRows.filter(r => r.needsEn && enInventory && enInventory.titleIndex.size > 0 && enAllowedRoots && enAllowedRoots.length > 0).map(r => r.title).filter(Boolean);
  const frTitlesNeeded = unmatchedRows.filter(r => r.needsFr && frInventory && frInventory.titleIndex.size > 0 && frAllowedRoots && frAllowedRoots.length > 0).map(r => r.title).filter(Boolean);

  let enTranslations = new Map<string, string>();
  let frTranslations = new Map<string, string>();

  if (enTitlesNeeded.length > 0) {
    log(`  Translating ${enTitlesNeeded.length} titles to English for title matching...`);
    enTranslations = await batchTranslate(enTitlesNeeded, "en", dbStorage);
    log(`  Translated ${enTranslations.size} titles to English`);
  }
  if (frTitlesNeeded.length > 0) {
    log(`  Translating ${frTitlesNeeded.length} titles to French for title matching...`);
    frTranslations = await batchTranslate(frTitlesNeeded, "fr", dbStorage);
    log(`  Translated ${frTranslations.size} titles to French`);
  }

  let titleMatches = 0;
  let rejected = { ambiguous: 0, noSegments: 0, depth: 0, crossValidation: 0, knownUrl: 0 };
  const usedEnUrls = new Set<string>();
  const usedFrUrls = new Set<string>();

  const candidates: { rowIndex: number; sourceUrl: string; enMatch: TitleMatchResult | null; frMatch: TitleMatchResult | null }[] = [];

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

    let enMatch: TitleMatchResult | null = null;
    let frMatch: TitleMatchResult | null = null;

    if (row.needsEn && enInventory && enInventory.titleIndex.size > 0 && enAllowedRoots && enAllowedRoots.length > 0) {
      const enTitle = enTranslations.get(row.title);
      if (enTitle) {
        enMatch = matchByTitle(enTitle, enInventory, 0.85, enAllowedRoots, enRefDepths, sourceSegments);
      }
    }

    if (row.needsFr && frInventory && frInventory.titleIndex.size > 0 && frAllowedRoots && frAllowedRoots.length > 0) {
      const frTitle = frTranslations.get(row.title);
      if (frTitle) {
        frMatch = matchByTitle(frTitle, frInventory, 0.85, frAllowedRoots, frRefDepths, sourceSegments);
      }
    }

    if (enMatch || frMatch) {
      candidates.push({ rowIndex: row.rowIndex, sourceUrl: row.sourceUrl, enMatch, frMatch });
    }
  }

  candidates.sort((a, b) => {
    const aConf = Math.max(a.enMatch?.similarity || 0, a.frMatch?.similarity || 0);
    const bConf = Math.max(b.enMatch?.similarity || 0, b.frMatch?.similarity || 0);
    return bConf - aConf;
  });

  for (const candidate of candidates) {
    let enMatch = candidate.enMatch;
    let frMatch = candidate.frMatch;

    if (enMatch && frMatch) {
      try {
        const enTail = new URL(enMatch.url).pathname.split("/").filter(Boolean).slice(-2).map(p => normalizeSegment(p));
        const frTail = new URL(frMatch.url).pathname.split("/").filter(Boolean).slice(-2).map(p => normalizeSegment(p));
        let tailOverlap = 0;
        for (const seg of enTail) {
          if (frTail.some(f => f === seg || (seg.length > 4 && f.includes(seg)) || (f.length > 4 && seg.includes(f)))) {
            tailOverlap++;
          }
        }
        if (tailOverlap === 0 && enTail.length > 0 && frTail.length > 0) {
          log(`    Cross-validation REJECTED BOTH: EN "${enMatch.url}" vs FR "${frMatch.url}" (no tail overlap, disagreement)`);
          enMatch = null;
          frMatch = null;
          rejected.crossValidation += 2;
        }
      } catch {}

      if (enMatch && enMatch.similarity < 0.90) {
        log(`    Paired EN REJECTED (similarity ${enMatch.similarity.toFixed(3)} < 0.90): "${enMatch.url}"`);
        enMatch = null;
        rejected.crossValidation++;
      }
      if (frMatch && frMatch.similarity < 0.90) {
        log(`    Paired FR REJECTED (similarity ${frMatch.similarity.toFixed(3)} < 0.90): "${frMatch.url}"`);
        frMatch = null;
        rejected.crossValidation++;
      }
    } else if (enMatch && !frMatch) {
      if (enMatch.similarity < 0.92) {
        log(`    Single-lang EN REJECTED (similarity ${enMatch.similarity.toFixed(3)} < 0.92): "${enMatch.url}"`);
        enMatch = null;
        rejected.crossValidation++;
      }
    } else if (frMatch && !enMatch) {
      if (frMatch.similarity < 0.92) {
        log(`    Single-lang FR REJECTED (similarity ${frMatch.similarity.toFixed(3)} < 0.92): "${frMatch.url}"`);
        frMatch = null;
        rejected.crossValidation++;
      }
    }

    const result: BatchMatchResult = {
      enUrl: null, frUrl: null,
      confidenceEn: null, confidenceFr: null,
      matchMethodEn: null, matchMethodFr: null,
    };

    if (enMatch && !usedEnUrls.has(enMatch.url)) {
      if (knownEnUrls && knownEnUrls.has(enMatch.url)) {
        log(`    Title match REJECTED (already known EN ref): ${enMatch.url}`);
        rejected.knownUrl++;
      } else {
        result.enUrl = enMatch.url;
        result.confidenceEn = enMatch.confidence;
        result.matchMethodEn = enMatch.method;
        usedEnUrls.add(enMatch.url);
      }
    }

    if (frMatch && !usedFrUrls.has(frMatch.url)) {
      if (knownFrUrls && knownFrUrls.has(frMatch.url)) {
        log(`    Title match REJECTED (already known FR ref): ${frMatch.url}`);
        rejected.knownUrl++;
      } else {
        result.frUrl = frMatch.url;
        result.confidenceFr = frMatch.confidence;
        result.matchMethodFr = frMatch.method;
        usedFrUrls.add(frMatch.url);
      }
    }

    if (result.enUrl || result.frUrl) {
      results.set(candidate.rowIndex, result);
      titleMatches++;
    }
  }

  log(`  Title matching found ${titleMatches} new matches (${usedEnUrls.size} EN, ${usedFrUrls.size} FR unique URLs)`);
  log(`  Title rejections: ambiguous=${rejected.ambiguous}, noSharedSegments=${rejected.noSegments}, crossValidation=${rejected.crossValidation}, knownUrl=${rejected.knownUrl}`);
  return results;
}

const AI_BATCH_SIZE = 15;
const AI_CONCURRENCY = 2;

interface AiMatchInput {
  rowIndex: number;
  title: string;
  sourceUrl: string;
  needsEn: boolean;
  needsFr: boolean;
}

interface AiSuggestion {
  sourceUrl: string;
  englishUrl: string | null;
  frenchUrl: string | null;
  reasoning: string;
}

export const AI_MODEL = "claude-opus-4-6";
export const AI_CONFIDENCE_SCORE = 82;
export const AI_METHOD_LABEL = "ai-match";

export const AI_SYSTEM_PROMPT_TEMPLATE = `You are a URL matching expert for a multilingual government website. Your task is to find the correct English and/or French equivalent pages for Hebrew source URLs.

CRITICAL RULES:
1. You may ONLY select URLs from the provided inventory lists below. NEVER invent or construct URLs.
2. If you cannot find a confident match, return null for that language. Leaving a cell blank is ALWAYS better than assigning a wrong URL.
3. Each target URL should only be used ONCE across all matches. Do not assign the same target URL to multiple source URLs.
4. URLs that are already matched should not appear again. Check the "already used" lists.
5. Focus on matching the page PURPOSE and CONTENT, not just superficial URL similarity.
6. Pay attention to the URL path structure - pages in the same section should map to the corresponding section in the target language.

WEBSITE STRUCTURE:
{{patternContext}}

EXAMPLES OF CORRECTLY MATCHED PAIRS:
{{exampleLines}}

ALREADY USED ENGLISH URLs (do NOT reuse these):
{{usedEnUrls}}

ALREADY USED FRENCH URLs (do NOT reuse these):
{{usedFrUrls}}`;

export const AI_USER_PROMPT_TEMPLATE = `Find the matching English and/or French URLs for each of these Hebrew source URLs.

UNMATCHED SOURCE URLs:
{{urlsBlock}}

AVAILABLE ENGLISH URLs (pick ONLY from this list):
{{enInventoryList}}

AVAILABLE FRENCH URLs (pick ONLY from this list):
{{frInventoryList}}

For each source URL, respond with a JSON array of objects. Each object must have:
- "sourceUrl": the original Hebrew source URL
- "englishUrl": the matching English URL from the inventory, or null if no confident match
- "frenchUrl": the matching French URL from the inventory, or null if no confident match
- "reasoning": a brief explanation of why you matched these URLs (or why no match was found)

Return ONLY the JSON array, no markdown formatting, no code fences, no other text.`;

export const AI_VALIDATION_PIPELINE = [
  { step: 1, name: "Inventory membership check", description: "Every URL suggested by the AI must exist in the crawl inventory (the full set of URLs discovered during directory crawling). URLs not in inventory are rejected." },
  { step: 2, name: "Duplicate check", description: "Each target URL can only be assigned to one source URL. If the AI suggests a URL already assigned by an earlier match (from any step), it is rejected." },
  { step: 3, name: "HEAD request verification", description: "All AI-suggested URLs are verified with HTTP HEAD requests (50 concurrent, 3s timeout). URLs returning non-200 status are discarded." },
  { step: 4, name: "Depth validation", description: "The URL path depth of the suggested target must be within ±1 of the source URL depth. This prevents matching top-level section pages to deep sub-pages." },
];

export function getAiConfig() {
  return {
    model: AI_MODEL,
    provider: "Anthropic (via Replit AI Integrations)",
    confidenceScore: AI_CONFIDENCE_SCORE,
    methodLabel: AI_METHOD_LABEL,
    batchSize: AI_BATCH_SIZE,
    systemPromptTemplate: AI_SYSTEM_PROMPT_TEMPLATE,
    userPromptTemplate: AI_USER_PROMPT_TEMPLATE,
    validationPipeline: AI_VALIDATION_PIPELINE,
    matchingRules: [
      "AI matching is the FINAL fallback — only runs on URLs unmatched after pattern construction, crawl inventory matching, fuzzy matching, and title-based matching",
      "AI is constrained to ONLY select from the crawl inventory — it can never invent URLs",
      "Batches of ~15 unmatched URLs are processed per API call",
      "Accuracy over completeness: returning null is always preferred over a wrong match",
      "AI matches get confidence score of 82 and method label 'ai-match'",
      "Multi-pass: after each processing pass, newly matched URLs become reference rows for improved pattern learning",
    ],
  };
}

export async function aiMatchUnmatched(
  unmatchedRows: AiMatchInput[],
  enInventory: CrawlInventory | null,
  frInventory: CrawlInventory | null,
  tabPatterns: TabPatterns,
  matchedExamples: { sourceUrl: string; enUrl?: string; frUrl?: string }[],
  enTranslations: Map<string, string>,
  frTranslations: Map<string, string>,
  knownEnUrls: Set<string>,
  knownFrUrls: Set<string>,
): Promise<Map<number, BatchMatchResult>> {
  const results = new Map<number, BatchMatchResult>();

  if (unmatchedRows.length === 0) return results;

  const anthropic = new Anthropic({
    apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  });

  const enInventoryUrls = enInventory ? Array.from(enInventory.urls) : [];
  const frInventoryUrls = frInventory ? Array.from(frInventory.urls) : [];

  const exampleLines = matchedExamples.slice(0, 8).map(ex => {
    const parts = [`  Source: ${ex.sourceUrl}`];
    if (ex.enUrl) parts.push(`  English: ${ex.enUrl}`);
    if (ex.frUrl) parts.push(`  French: ${ex.frUrl}`);
    return parts.join("\n");
  }).join("\n---\n");

  const patternContext: string[] = [];
  if (tabPatterns.enRoot.length > 0) {
    patternContext.push(`English section root path: /${tabPatterns.enRoot.join("/")}/`);
    patternContext.push(`Hebrew source root path for English: /${tabPatterns.enSrcRoot.join("/")}/`);
  }
  if (tabPatterns.frRoot.length > 0) {
    patternContext.push(`French section root path: /${tabPatterns.frRoot.join("/")}/`);
    patternContext.push(`Hebrew source root path for French: /${tabPatterns.frSrcRoot.join("/")}/`);
  }
  if (tabPatterns.segmentMap.get("en")?.size) {
    const segs = Array.from(tabPatterns.segmentMap.get("en")!.entries()).slice(0, 15);
    patternContext.push(`Known Hebrew→English segment translations: ${segs.map(([k,v]) => `${k}→${v}`).join(", ")}`);
  }
  if (tabPatterns.segmentMap.get("fr")?.size) {
    const segs = Array.from(tabPatterns.segmentMap.get("fr")!.entries()).slice(0, 15);
    patternContext.push(`Known Hebrew→French segment translations: ${segs.map(([k,v]) => `${k}→${v}`).join(", ")}`);
  }

  const batches: AiMatchInput[][] = [];
  for (let i = 0; i < unmatchedRows.length; i += AI_BATCH_SIZE) {
    batches.push(unmatchedRows.slice(i, i + AI_BATCH_SIZE));
  }

  log(`  AI matching (${AI_MODEL}): ${unmatchedRows.length} unmatched URLs in ${batches.length} batches (inventory: ${enInventoryUrls.length} EN, ${frInventoryUrls.length} FR)`);

  const usedEnUrls = new Set<string>(knownEnUrls);
  const usedFrUrls = new Set<string>(knownFrUrls);
  let aiMatches = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    const urlsBlock = batch.map(row => {
      const parts = [`- Source URL: ${row.sourceUrl}`];
      parts.push(`  Title (Hebrew): ${row.title || "N/A"}`);
      const enTitle = enTranslations.get(row.title);
      const frTitle = frTranslations.get(row.title);
      if (enTitle) parts.push(`  Title (English translation): ${enTitle}`);
      if (frTitle) parts.push(`  Title (French translation): ${frTitle}`);
      if (row.needsEn) parts.push(`  Needs: English URL`);
      if (row.needsFr) parts.push(`  Needs: French URL`);
      return parts.join("\n");
    }).join("\n\n");

    const enListForBatch = enInventoryUrls.length <= 500
      ? enInventoryUrls.join("\n")
      : enInventoryUrls.slice(0, 500).join("\n") + `\n... (${enInventoryUrls.length - 500} more)`;

    const frListForBatch = frInventoryUrls.length <= 500
      ? frInventoryUrls.join("\n")
      : frInventoryUrls.slice(0, 500).join("\n") + `\n... (${frInventoryUrls.length - 500} more)`;

    const systemPrompt = AI_SYSTEM_PROMPT_TEMPLATE
      .replace("{{patternContext}}", patternContext.join("\n"))
      .replace("{{exampleLines}}", exampleLines)
      .replace("{{usedEnUrls}}", Array.from(usedEnUrls).slice(-50).join("\n") || "(none)")
      .replace("{{usedFrUrls}}", Array.from(usedFrUrls).slice(-50).join("\n") || "(none)");

    const userPrompt = AI_USER_PROMPT_TEMPLATE
      .replace("{{urlsBlock}}", urlsBlock)
      .replace("{{enInventoryList}}", enListForBatch || "(no English inventory available)")
      .replace("{{frInventoryList}}", frListForBatch || "(no French inventory available)");

    try {
      const message = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [
          { role: "user", content: userPrompt },
        ],
      });

      const textBlock = message.content.find(b => b.type === "text");
      const content = textBlock?.text;
      if (!content) {
        log(`    AI batch ${batchIdx + 1}/${batches.length}: empty response`);
        continue;
      }

      let suggestions: AiSuggestion[] = [];
      try {
        const jsonStr = content.replace(/^```json?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
        const parsed = JSON.parse(jsonStr);
        suggestions = Array.isArray(parsed) ? parsed : (parsed.matches || parsed.results || parsed.urls || []);
      } catch {
        log(`    AI batch ${batchIdx + 1}/${batches.length}: failed to parse response`);
        continue;
      }

      let batchMatches = 0;
      for (const suggestion of suggestions) {
        if (!suggestion.sourceUrl) continue;

        const row = batch.find(r => r.sourceUrl === suggestion.sourceUrl);
        if (!row) continue;

        const result: BatchMatchResult = {
          enUrl: null, frUrl: null,
          confidenceEn: null, confidenceFr: null,
          matchMethodEn: null, matchMethodFr: null,
        };

        if (suggestion.englishUrl && row.needsEn) {
          if (!enInventory?.urls.has(suggestion.englishUrl)) {
            log(`    AI REJECTED (not in inventory): EN ${suggestion.englishUrl}`);
          } else if (usedEnUrls.has(suggestion.englishUrl)) {
            log(`    AI REJECTED (already used): EN ${suggestion.englishUrl}`);
          } else {
            result.enUrl = suggestion.englishUrl;
            result.confidenceEn = AI_CONFIDENCE_SCORE;
            result.matchMethodEn = AI_METHOD_LABEL;
            usedEnUrls.add(suggestion.englishUrl);
          }
        }

        if (suggestion.frenchUrl && row.needsFr) {
          if (!frInventory?.urls.has(suggestion.frenchUrl)) {
            log(`    AI REJECTED (not in inventory): FR ${suggestion.frenchUrl}`);
          } else if (usedFrUrls.has(suggestion.frenchUrl)) {
            log(`    AI REJECTED (already used): FR ${suggestion.frenchUrl}`);
          } else {
            result.frUrl = suggestion.frenchUrl;
            result.confidenceFr = AI_CONFIDENCE_SCORE;
            result.matchMethodFr = AI_METHOD_LABEL;
            usedFrUrls.add(suggestion.frenchUrl);
          }
        }

        if (result.enUrl || result.frUrl) {
          results.set(row.rowIndex, result);
          batchMatches++;
          if (suggestion.reasoning) {
            log(`    AI match: ${row.sourceUrl} -> EN:${result.enUrl || "null"} FR:${result.frUrl || "null"} (${suggestion.reasoning})`);
          }
        }
      }

      aiMatches += batchMatches;
      log(`  AI batch ${batchIdx + 1}/${batches.length}: ${batchMatches} matches from ${batch.length} URLs`);
    } catch (error: any) {
      log(`  AI batch ${batchIdx + 1}/${batches.length} error: ${error?.message?.substring(0, 200)}`);
    }

    if (batchIdx < batches.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  log(`  AI matching complete: ${aiMatches} total matches from ${unmatchedRows.length} unmatched URLs`);
  return results;
}
