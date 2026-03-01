import { log } from "./index";
import * as cheerio from "cheerio";
import type { IStorage } from "./storage";
import Anthropic from "@anthropic-ai/sdk";

export interface DirectoryMapping {
  sourceDir: string;
  targetDir: string;
  lang: "en" | "fr";
}

export interface ReferenceConflict {
  sourceUrl: string;
  targetUrl: string;
  lang: "en" | "fr";
  reason: string;
  expectedTargetDir: string;
  actualTargetDir: string;
}

export interface ValidatedReferences {
  cleanedRows: { sourceUrl: string; enUrl?: string; frUrl?: string }[];
  conflicts: ReferenceConflict[];
}

export interface TabPatterns {
  directoryMappings: DirectoryMapping[];
  segmentMap: Map<string, Map<string, string>>;
  enRoot: string[];
  frRoot: string[];
  enSrcRoot: string[];
  frSrcRoot: string[];
}

export interface BatchMatchResult {
  enUrl: string | null;
  frUrl: string | null;
  confidenceEn: number | null;
  confidenceFr: number | null;
  matchMethodEn: string | null;
  matchMethodFr: string | null;
}

const translationCache = new Map<string, string>();

export function clearCaches() {
}

export function clearAllCaches() {
  translationCache.clear();
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

function getDirectoryPath(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const clean = stripSuffix(parts);
    if (clean.length <= 1) return "/" + clean.join("/");
    return "/" + clean.slice(0, -1).join("/");
  } catch {
    return "/";
  }
}

function getRelativePath(urlStr: string, rootDir: string): string {
  try {
    const parsed = new URL(urlStr);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const clean = stripSuffix(parts);
    const rootParts = rootDir.split("/").filter(Boolean);
    let matchLen = 0;
    for (let i = 0; i < rootParts.length && i < clean.length; i++) {
      if (normalizeSegment(clean[i]) === normalizeSegment(rootParts[i])) {
        matchLen++;
      } else {
        break;
      }
    }
    return clean.slice(matchLen).map(p => normalizeSegment(p)).join("/");
  } catch {
    return "";
  }
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

function computeRootMapping(
  pairs: { src: string[]; tgt: string[] }[],
  segMap: Map<string, string>
): { sourceRoot: string[]; targetRoot: string[] } | null {
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
  return { sourceRoot: commonSrcRoot, targetRoot: commonTgtRoot };
}

export function validateReferenceRows(
  rows: { sourceUrl: string; enUrl?: string; frUrl?: string }[]
): ValidatedReferences {
  const conflicts: ReferenceConflict[] = [];

  type RefPair = { sourceUrl: string; targetUrl: string; sourceDir: string; targetDir: string; lang: "en" | "fr" };
  const allPairs: RefPair[] = [];

  for (const row of rows) {
    try {
      const sourceParsed = new URL(row.sourceUrl);
      if (row.enUrl) {
        try {
          const enParsed = new URL(row.enUrl);
          if (enParsed.origin === sourceParsed.origin) {
            allPairs.push({
              sourceUrl: row.sourceUrl,
              targetUrl: row.enUrl,
              sourceDir: getDirectoryPath(row.sourceUrl),
              targetDir: getDirectoryPath(row.enUrl),
              lang: "en",
            });
          }
        } catch {}
      }
      if (row.frUrl) {
        try {
          const frParsed = new URL(row.frUrl);
          if (frParsed.origin === sourceParsed.origin) {
            allPairs.push({
              sourceUrl: row.sourceUrl,
              targetUrl: row.frUrl,
              sourceDir: getDirectoryPath(row.sourceUrl),
              targetDir: getDirectoryPath(row.frUrl),
              lang: "fr",
            });
          }
        } catch {}
      }
    } catch {}
  }

  if (allPairs.length <= 1) {
    return { cleanedRows: rows.slice(), conflicts };
  }

  function normalizeDirForComparison(dir: string): string[] {
    const segs = dir.split("/").filter(Boolean);
    if (segs.length > 0 && segs[segs.length - 1].toLowerCase() === "pages") {
      segs.pop();
    }
    return segs;
  }

  function isAncestorOrEqual(parentSegs: string[], childSegs: string[]): boolean {
    if (parentSegs.length > childSegs.length) return false;
    return parentSegs.every((seg, i) => seg.toLowerCase() === childSegs[i]?.toLowerCase());
  }

  function dirsAreRelated(dirA: string, dirB: string): boolean {
    const segsA = normalizeDirForComparison(dirA);
    const segsB = normalizeDirForComparison(dirB);
    return isAncestorOrEqual(segsA, segsB) || isAncestorOrEqual(segsB, segsA);
  }

  const consensusMap = new Map<string, Map<string, number>>();

  for (const pair of allPairs) {
    const key = `${pair.lang}:${pair.sourceDir}`;
    if (!consensusMap.has(key)) consensusMap.set(key, new Map());
    const votes = consensusMap.get(key)!;
    votes.set(pair.targetDir, (votes.get(pair.targetDir) || 0) + 1);
  }

  function getConsensusTargetDir(lang: "en" | "fr", sourceDir: string): string | null {
    const key = `${lang}:${sourceDir}`;
    const votes = consensusMap.get(key);
    if (!votes || votes.size === 0) return null;
    if (votes.size === 1) {
      const [dir] = votes.keys();
      return dir;
    }
    let best = "";
    let bestCount = 0;
    let tieCount = 0;
    for (const [dir, count] of votes) {
      if (count > bestCount) {
        bestCount = count;
        best = dir;
        tieCount = 1;
      } else if (count === bestCount) {
        tieCount++;
      }
    }
    if (tieCount === 1 && bestCount >= 2) return best;
    return null;
  }

  function getParentDir(dir: string): string | null {
    const parts = dir.split("/").filter(Boolean);
    if (parts.length <= 1) return null;
    return "/" + parts.slice(0, -1).join("/");
  }

  function findAncestorConsensus(lang: "en" | "fr", sourceDir: string): { parentSourceDir: string; parentTargetDir: string } | null {
    let current = getParentDir(sourceDir);
    while (current && current !== "/") {
      const consensus = getConsensusTargetDir(lang, current);
      if (consensus) {
        return { parentSourceDir: current, parentTargetDir: consensus };
      }
      current = getParentDir(current);
    }
    return null;
  }

  const flaggedPairs = new Set<string>();

  for (const pair of allPairs) {
    const pairKey = `${pair.lang}:${pair.sourceUrl}:${pair.targetUrl}`;

    const directConsensus = getConsensusTargetDir(pair.lang, pair.sourceDir);
    if (directConsensus && directConsensus !== pair.targetDir) {
      if (dirsAreRelated(directConsensus, pair.targetDir)) {
        continue;
      }

      const key = `${pair.lang}:${pair.sourceDir}`;
      const votes = consensusMap.get(key)!;
      const consensusVotes = votes.get(directConsensus) || 0;
      const pairVotes = votes.get(pair.targetDir) || 0;

      if (consensusVotes > pairVotes) {
        conflicts.push({
          sourceUrl: pair.sourceUrl,
          targetUrl: pair.targetUrl,
          lang: pair.lang,
          reason: `Directory mapping conflicts with majority: ${pair.sourceDir} → ${pair.targetDir} (${pairVotes} vote${pairVotes !== 1 ? "s" : ""}) vs consensus ${pair.sourceDir} → ${directConsensus} (${consensusVotes} vote${consensusVotes !== 1 ? "s" : ""})`,
          expectedTargetDir: directConsensus,
          actualTargetDir: pair.targetDir,
        });
        flaggedPairs.add(pairKey);
        continue;
      }
    }

    const ancestor = findAncestorConsensus(pair.lang, pair.sourceDir);
    if (ancestor) {
      const targetSegments = normalizeDirForComparison(pair.targetDir);
      const parentTargetSegments = normalizeDirForComparison(ancestor.parentTargetDir);

      if (!isAncestorOrEqual(parentTargetSegments, targetSegments)) {
        const sourceDirParts = pair.sourceDir.split("/").filter(Boolean);
        const parentSourceParts = ancestor.parentSourceDir.split("/").filter(Boolean);
        const childSegments = sourceDirParts.slice(parentSourceParts.length);

        const parentTargetNorm = ancestor.parentTargetDir.replace(/\/+$/, "");
        const expectedChildTarget = childSegments.length > 0
          ? parentTargetNorm + "/" + childSegments.join("/")
          : parentTargetNorm;

        conflicts.push({
          sourceUrl: pair.sourceUrl,
          targetUrl: pair.targetUrl,
          lang: pair.lang,
          reason: `Target directory "${pair.targetDir}" is not under parent mapping "${ancestor.parentSourceDir}" → "${ancestor.parentTargetDir}". Expected target under "${ancestor.parentTargetDir}/"`,
          expectedTargetDir: expectedChildTarget,
          actualTargetDir: pair.targetDir,
        });
        flaggedPairs.add(pairKey);
      }
    }
  }

  if (conflicts.length === 0) {
    return { cleanedRows: rows.slice(), conflicts };
  }

  log(`  Reference validation: ${conflicts.length} conflict(s) detected`);
  for (const c of conflicts) {
    log(`    CONFLICT [${c.lang.toUpperCase()}]: ${c.sourceUrl} → ${c.targetUrl}`);
    log(`      ${c.reason}`);
  }

  const flaggedSourceTargetPairs = new Map<string, Set<string>>();
  for (const c of conflicts) {
    const key = c.sourceUrl;
    if (!flaggedSourceTargetPairs.has(key)) flaggedSourceTargetPairs.set(key, new Set());
    if (c.lang === "en") {
      flaggedSourceTargetPairs.get(key)!.add(`en:${c.targetUrl}`);
    } else {
      flaggedSourceTargetPairs.get(key)!.add(`fr:${c.targetUrl}`);
    }
  }

  const cleanedRows: { sourceUrl: string; enUrl?: string; frUrl?: string }[] = [];
  for (const row of rows) {
    const flagged = flaggedSourceTargetPairs.get(row.sourceUrl);
    if (!flagged) {
      cleanedRows.push({ ...row });
      continue;
    }

    const cleaned: { sourceUrl: string; enUrl?: string; frUrl?: string } = { sourceUrl: row.sourceUrl };
    if (row.enUrl && !flagged.has(`en:${row.enUrl}`)) {
      cleaned.enUrl = row.enUrl;
    }
    if (row.frUrl && !flagged.has(`fr:${row.frUrl}`)) {
      cleaned.frUrl = row.frUrl;
    }
    if (cleaned.enUrl || cleaned.frUrl) {
      cleanedRows.push(cleaned);
    }
  }

  log(`  Reference validation: ${rows.length} input rows → ${cleanedRows.length} clean rows (${rows.length - cleanedRows.length} fully removed, ${conflicts.length} individual mappings flagged)`);

  return { cleanedRows, conflicts };
}

export function learnTabPatterns(
  rows: { sourceUrl: string; enUrl?: string; frUrl?: string }[]
): TabPatterns {
  const segmentMap = new Map<string, Map<string, string>>();
  segmentMap.set("en", new Map());
  segmentMap.set("fr", new Map());

  const enPairs: { src: string[]; tgt: string[] }[] = [];
  const frPairs: { src: string[]; tgt: string[] }[] = [];

  const directoryMappings: DirectoryMapping[] = [];
  const seenDirMappings = new Set<string>();

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

            const srcDir = getDirectoryPath(row.sourceUrl);
            const tgtDir = getDirectoryPath(row.enUrl);
            const key = `en:${srcDir}:${tgtDir}`;
            if (!seenDirMappings.has(key)) {
              seenDirMappings.add(key);
              directoryMappings.push({ sourceDir: srcDir, targetDir: tgtDir, lang: "en" });
            }
          }
        } catch {}
      }

      if (row.frUrl) {
        try {
          const frParsed = new URL(row.frUrl);
          if (frParsed.origin === sourceParsed.origin) {
            const frParts = frParsed.pathname.split("/").filter(Boolean);
            frPairs.push({ src: stripSuffix(sourceParts), tgt: stripSuffix(frParts) });

            const srcDir = getDirectoryPath(row.sourceUrl);
            const tgtDir = getDirectoryPath(row.frUrl);
            const key = `fr:${srcDir}:${tgtDir}`;
            if (!seenDirMappings.has(key)) {
              seenDirMappings.add(key);
              directoryMappings.push({ sourceDir: srcDir, targetDir: tgtDir, lang: "fr" });
            }
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

  log(`Tab patterns learned:`);
  if (enMapping) log(`  EN: /${enSrcRoot.join("/") || "*"}/ → /${enRoot.join("/")}/`);
  if (frMapping) log(`  FR: /${frSrcRoot.join("/") || "*"}/ → /${frRoot.join("/")}/`);
  log(`  Directory mappings: ${directoryMappings.length} (${directoryMappings.filter(d => d.lang === "en").length} EN, ${directoryMappings.filter(d => d.lang === "fr").length} FR)`);
  const enSeg = segmentMap.get("en")?.size || 0;
  const frSeg = segmentMap.get("fr")?.size || 0;
  log(`  Segment translations: ${enSeg} EN, ${frSeg} FR`);

  return {
    directoryMappings,
    segmentMap,
    enRoot, frRoot,
    enSrcRoot, frSrcRoot,
  };
}

export function findTargetDirectory(
  sourceUrl: string,
  lang: "en" | "fr",
  tabPatterns: TabPatterns
): string | null {
  const sourceDir = getDirectoryPath(sourceUrl);
  const langMappings = tabPatterns.directoryMappings.filter(m => m.lang === lang);

  let bestMatch: DirectoryMapping | null = null;
  let bestMatchLen = 0;

  for (const mapping of langMappings) {
    const srcNorm = mapping.sourceDir.toLowerCase();
    const sourceDirNorm = sourceDir.toLowerCase();
    if (sourceDirNorm.startsWith(srcNorm) || sourceDirNorm === srcNorm) {
      if (srcNorm.length > bestMatchLen) {
        bestMatchLen = srcNorm.length;
        bestMatch = mapping;
      }
    }
  }

  if (bestMatch) {
    const sourceDir_lower = sourceDir.toLowerCase();
    const bestSrcNorm = bestMatch.sourceDir.toLowerCase();
    if (sourceDir_lower === bestSrcNorm) {
      return bestMatch.targetDir;
    }
    const remainder = sourceDir.substring(bestMatch.sourceDir.length);
    if (remainder) {
      const remainderParts = remainder.split("/").filter(Boolean);
      const segments = tabPatterns.segmentMap.get(lang);
      const translatedParts = remainderParts.map(part => {
        const norm = normalizeSegment(part);
        if (segments && segments.has(norm)) return segments.get(norm)!;
        return part;
      });
      return bestMatch.targetDir + "/" + translatedParts.join("/");
    }
    return bestMatch.targetDir;
  }

  const sourceRoot = lang === "en" ? tabPatterns.enSrcRoot : tabPatterns.frSrcRoot;
  const targetRoot = lang === "en" ? tabPatterns.enRoot : tabPatterns.frRoot;
  if (targetRoot.length === 0) return null;

  const sourceParts = sourceDir.split("/").filter(Boolean);
  const segments = tabPatterns.segmentMap.get(lang);

  let matchLen = 0;
  for (let i = 0; i < sourceRoot.length && i < sourceParts.length; i++) {
    if (normalizeSegment(sourceParts[i]) === normalizeSegment(sourceRoot[i])) {
      matchLen++;
    } else {
      break;
    }
  }

  const remaining = sourceParts.slice(matchLen);
  const translatedRemaining = remaining.map(part => {
    const norm = normalizeSegment(part);
    if (segments && segments.has(norm)) return segments.get(norm)!;
    return part;
  });

  return "/" + [...targetRoot, ...translatedRemaining].join("/");
}

const CRAWL_CONCURRENCY = 30;
const CRAWL_TIMEOUT = 8000;
const CRAWL_MAX_PAGES = 2000;
const CRAWL_MAX_DEPTH = 6;

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

export async function crawlDirectory(
  origin: string,
  rootPath: string[],
  onProgress?: (crawled: number, queued: number) => void,
  options?: { maxPages?: number; maxDepth?: number }
): Promise<CrawlInventory> {
  const inventory: CrawlInventory = {
    urls: new Set(),
    normalizedIndex: new Map(),
    tailIndex: new Map(),
    titleIndex: new Map(),
    lastSegWordIndex: new Map(),
  };

  const maxPages = options?.maxPages ?? CRAWL_MAX_PAGES;
  const maxDepth = options?.maxDepth ?? CRAWL_MAX_DEPTH;

  const scopePrefix = "/" + rootPath.join("/");
  const startUrl = origin + scopePrefix + "/";

  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];

  if (rootPath.length > 0) {
    const defaultUrl = origin + scopePrefix + "/Pages/default.aspx";
    queue.push({ url: defaultUrl, depth: 0 });
  }

  let crawled = 0;

  while (queue.length > 0 && crawled < maxPages) {
    const batch = queue.splice(0, CRAWL_CONCURRENCY);
    const toFetch = batch.filter((item) => !visited.has(item.url));
    for (const item of toFetch) visited.add(item.url);

    if (toFetch.length === 0) continue;

    const results = await Promise.all(
      toFetch.map(async (item) => {
        const html = await fetchPage(item.url);
        return { url: item.url, depth: item.depth, html };
      })
    );

    for (const { url, depth, html } of results) {
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

        if (depth < maxDepth) {
          const links = extractLinks(html, url, scopePrefix);
          for (const link of links) {
            if (!visited.has(link)) {
              queue.push({ url: link, depth: depth + 1 });
            }
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

export function buildInventoryFromDbRows(rows: { url: string; title: string | null }[]): CrawlInventory {
  const inventory: CrawlInventory = {
    urls: new Set(),
    normalizedIndex: new Map(),
    tailIndex: new Map(),
    titleIndex: new Map(),
    lastSegWordIndex: new Map(),
  };
  for (const row of rows) {
    addToInventory(inventory, row.url);
    if (row.title) {
      inventory.titleIndex.set(row.url, row.title);
    }
  }
  return inventory;
}

export function getScopedInventory(
  inventory: CrawlInventory,
  directoryPath: string,
  origin: string
): CrawlInventory {
  const scoped: CrawlInventory = {
    urls: new Set(),
    normalizedIndex: new Map(),
    tailIndex: new Map(),
    titleIndex: new Map(),
    lastSegWordIndex: new Map(),
  };

  const dirLower = directoryPath.toLowerCase();

  for (const url of inventory.urls) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname.toLowerCase().startsWith(dirLower)) {
        addToInventory(scoped, url);
        const title = inventory.titleIndex.get(url);
        if (title) {
          scoped.titleIndex.set(url, title);
        }
      }
    } catch {}
  }

  return scoped;
}

export function matchInDirectory(
  sourceUrl: string,
  lang: "en" | "fr",
  tabPatterns: TabPatterns,
  scopedInventory: CrawlInventory,
): { url: string; confidence: number; method: string } | null {
  const sourceRoot = lang === "en" ? tabPatterns.enSrcRoot : tabPatterns.frSrcRoot;
  const targetRoot = lang === "en" ? tabPatterns.enRoot : tabPatterns.frRoot;
  const segments = tabPatterns.segmentMap.get(lang);

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

    if (segments && srcTailParts.length > 0) {
      const translatedParts = srcTailParts.map(part => {
        const norm = normalizeSegment(part);
        return segments.has(norm) ? segments.get(norm)! : part;
      });
      const candidatePath = [...targetRoot, ...translatedParts].map(p => normalizeSegment(p)).join("/");
      const inventoryUrl = scopedInventory.normalizedIndex.get(candidatePath);
      if (inventoryUrl) {
        return { url: inventoryUrl, confidence: 95, method: "dir-pattern" };
      }
    }

    const srcNormPath = cleanSrc.map(p => normalizeSegment(p)).join("/");
    for (const [normPath, realUrl] of scopedInventory.normalizedIndex) {
      const tgtParts = normPath.split("/");
      const srcLast = srcTailParts.map(p => normalizeSegment(p));
      const tgtLast = tgtParts.slice(-srcLast.length);
      if (srcLast.length > 0 && tgtLast.length === srcLast.length) {
        let allMatch = true;
        for (let i = 0; i < srcLast.length; i++) {
          if (srcLast[i] !== tgtLast[i]) { allMatch = false; break; }
        }
        if (allMatch) {
          return { url: realUrl, confidence: 93, method: "dir-path" };
        }
      }
    }

    if (srcTailParts.length >= 1) {
      const lastSeg = normalizeSegment(srcTailParts[srcTailParts.length - 1]);
      if (lastSeg && lastSeg !== "pages") {
        const candidates = scopedInventory.tailIndex.get(lastSeg) || [];
        if (candidates.length === 1) {
          return { url: candidates[0], confidence: 88, method: "dir-tail" };
        }

        if (srcTailParts.length >= 2 && candidates.length !== 1) {
          const tail2 = srcTailParts.slice(-2).map(p => normalizeSegment(p)).join("/");
          const candidates2 = scopedInventory.tailIndex.get(tail2) || [];
          if (candidates2.length === 1) {
            return { url: candidates2[0], confidence: 90, method: "dir-tail2" };
          }
        }
      }
    }

    if (srcTailParts.length >= 1 && segments) {
      const translatedTail = srcTailParts.map(p => {
        const norm = normalizeSegment(p);
        if (segments.has(norm)) return normalizeSegment(segments.get(norm)!);
        return norm;
      });

      for (let tailLen = Math.min(translatedTail.length, 3); tailLen >= 1; tailLen--) {
        const tailKey = translatedTail.slice(-tailLen).join("/");
        const candidates = scopedInventory.tailIndex.get(tailKey) || [];
        if (candidates.length === 1) {
          return { url: candidates[0], confidence: 86, method: "dir-translated-tail" };
        }
      }
    }

    if (srcTailParts.length >= 1) {
      const result = fuzzySegmentMatch(srcTailParts, lang, tabPatterns, scopedInventory);
      if (result) return result;
    }
  } catch {}

  return null;
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
    if (result) return { url: result.url, confidence: Math.round(80 + result.score * 10), method: "dir-fuzzy" };
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
          if (result) return { url: result.url, confidence: Math.round(80 + result.score * 10), method: "dir-fuzzy-translated" };
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
  sourceSegments?: Set<string>,
): TitleMatchResult | null {
  let bestMatch: TitleMatchResult | null = null;
  let bestSimilarity = minSimilarity;
  let secondBestSimilarity = 0;

  const translatedParts = splitTitleParts(translatedTitle);
  const translatedSection = translatedParts.section ? normalizeTitle(translatedParts.section) : "";
  const hasSection = translatedSection.length > 0;

  inventory.titleIndex.forEach((pageTitle, url) => {
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
        method: usedSection ? "dir-title-section" : "dir-title",
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

    if (sourceSegments && sourceSegments.size > 0) {
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
  }

  return finalMatch;
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

export async function titleMatchUnmatched(
  unmatchedRows: { rowIndex: number; title: string; sourceUrl: string; needsEn: boolean; needsFr: boolean }[],
  enScopedInventory: CrawlInventory | null,
  frScopedInventory: CrawlInventory | null,
  dbStorage?: IStorage,
  knownEnUrls?: Set<string>,
  knownFrUrls?: Set<string>,
): Promise<Map<number, BatchMatchResult>> {
  const results = new Map<number, BatchMatchResult>();

  if (unmatchedRows.length === 0) return results;

  const titles = unmatchedRows.map((r) => r.title).filter(Boolean);
  if (titles.length === 0) return results;

  const enTitlesNeeded = unmatchedRows.filter(r => r.needsEn && enScopedInventory && enScopedInventory.titleIndex.size > 0).map(r => r.title).filter(Boolean);
  const frTitlesNeeded = unmatchedRows.filter(r => r.needsFr && frScopedInventory && frScopedInventory.titleIndex.size > 0).map(r => r.title).filter(Boolean);

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
  let rejected = { ambiguous: 0, noSegments: 0, crossValidation: 0, knownUrl: 0 };
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

    if (row.needsEn && enScopedInventory && enScopedInventory.titleIndex.size > 0) {
      const enTitle = enTranslations.get(row.title);
      if (enTitle) {
        enMatch = matchByTitle(enTitle, enScopedInventory, 0.85, sourceSegments);
      }
    }

    if (row.needsFr && frScopedInventory && frScopedInventory.titleIndex.size > 0) {
      const frTitle = frTranslations.get(row.title);
      if (frTitle) {
        frMatch = matchByTitle(frTitle, frScopedInventory, 0.85, sourceSegments);
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
          log(`    Cross-validation REJECTED BOTH: EN "${enMatch.url}" vs FR "${frMatch.url}" (no tail overlap)`);
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

interface AiMatchInput {
  rowIndex: number;
  title: string;
  sourceUrl: string;
  needsEn: boolean;
  needsFr: boolean;
  enDirectoryContext?: string;
  frDirectoryContext?: string;
}

interface AiSuggestion {
  sourceUrl: string;
  englishUrl: string | null;
  frenchUrl: string | null;
  reasoning: string;
}

export const AI_MODEL = "claude-opus-4-6";
export const AI_CONFIDENCE_SCORE = 82;
export const AI_METHOD_LABEL = "dir-ai";

export const AI_SYSTEM_PROMPT_TEMPLATE = `You are a URL matching expert for a multilingual government website. Your task is to find the correct English and/or French equivalent pages for Hebrew source URLs.

CRITICAL RULES:
1. You may ONLY select URLs from the provided inventory lists below. NEVER invent or construct URLs.
2. If you cannot find a confident match, return null for that language. Leaving a cell blank is ALWAYS better than assigning a wrong URL.
3. Each target URL should only be used ONCE across all matches. Do not assign the same target URL to multiple source URLs.
4. URLs that are already matched should not appear again. Check the "already used" lists.
5. Focus on matching the page PURPOSE and CONTENT, not just superficial URL similarity.
6. Pay attention to the DIRECTORY CONTEXT - each source URL belongs to a specific directory, and its match should be found within the corresponding target directory.

WEBSITE STRUCTURE:
{{patternContext}}

DIRECTORY CONTEXT:
{{directoryContext}}

EXAMPLES OF CORRECTLY MATCHED PAIRS:
{{exampleLines}}

ALREADY USED ENGLISH URLs (do NOT reuse these):
{{usedEnUrls}}

ALREADY USED FRENCH URLs (do NOT reuse these):
{{usedFrUrls}}`;

export const AI_USER_PROMPT_TEMPLATE = `Find the matching English and/or French URLs for each of these Hebrew source URLs. Each URL includes its directory context - focus your search within the indicated target directories.

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
  { step: 1, name: "Inventory membership check", description: "Every URL suggested by the AI must exist in the crawl inventory. URLs not in inventory are rejected." },
  { step: 2, name: "Duplicate check", description: "Each target URL can only be assigned to one source URL. Duplicates are rejected." },
  { step: 3, name: "Directory context check", description: "AI-suggested URLs are validated against the expected target directory scope." },
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
      "AI matching is the FINAL fallback — only runs on URLs unmatched after directory-scoped pattern matching, tail matching, fuzzy matching, and title-based matching",
      "AI is constrained to ONLY select from the crawl inventory — it can never invent URLs",
      "AI receives directory context: which source directory the URL belongs to and the corresponding target directory to search in",
      "Batches of ~15 unmatched URLs are processed per API call",
      "Accuracy over completeness: returning null is always preferred over a wrong match",
      "AI matches get confidence score of 82 and method label 'dir-ai'",
    ],
  };
}

function rankInventoryByTitleSimilarity(
  inventory: CrawlInventory,
  translatedTitles: string[],
  usedUrls: Set<string>,
  maxResults: number = 200,
): string[] {
  const scored: { url: string; score: number }[] = [];

  for (const [url, pageTitle] of inventory.titleIndex.entries()) {
    if (usedUrls.has(url)) continue;
    let bestSim = 0;
    for (const title of translatedTitles) {
      const sim = titleSimilarity(title, pageTitle);
      if (sim > bestSim) bestSim = sim;
    }
    if (bestSim > 0.15) {
      scored.push({ url, score: bestSim });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(s => s.url);
}

export function crossLanguageDerive(
  matchedUrl: string,
  fromLang: "en" | "fr",
  toLang: "en" | "fr",
  tabPatterns: TabPatterns,
  targetInventory: CrawlInventory,
  usedUrls: Set<string>,
): { url: string; confidence: number; method: string } | null {
  const fromRoot = fromLang === "en" ? tabPatterns.enRoot : tabPatterns.frRoot;
  const toRoot = toLang === "en" ? tabPatterns.enRoot : tabPatterns.frRoot;

  if (fromRoot.length === 0 || toRoot.length === 0) return null;

  try {
    const parsed = new URL(matchedUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);

    let rootMatchLen = 0;
    for (let i = 0; i < fromRoot.length && i < parts.length; i++) {
      if (normalizeSegment(parts[i]) === normalizeSegment(fromRoot[i])) {
        rootMatchLen++;
      } else {
        break;
      }
    }

    if (rootMatchLen === 0) return null;

    const remainder = parts.slice(rootMatchLen);
    const candidatePath = "/" + [...toRoot, ...remainder].join("/");
    const candidateNorm = candidatePath.toLowerCase();

    for (const url of targetInventory.urls) {
      if (usedUrls.has(url)) continue;
      const p = new URL(url);
      if (p.pathname.toLowerCase() === candidateNorm ||
          p.pathname.toLowerCase() === candidateNorm + "/pages/default.aspx" ||
          p.pathname.toLowerCase().replace(/\/pages\/[^/]+$/i, "") === candidateNorm) {
        return { url, confidence: 85, method: "dir-cross-lang" };
      }
    }

    const matchedTail = getUrlTail(matchedUrl, 2);
    if (matchedTail) {
      const tailMatches = targetInventory.tailIndex.get(matchedTail);
      if (tailMatches) {
        for (const url of tailMatches) {
          if (!usedUrls.has(url)) {
            return { url, confidence: 80, method: "dir-cross-lang-tail" };
          }
        }
      }
    }
  } catch {}

  return null;
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
  origin: string,
): Promise<Map<number, BatchMatchResult>> {
  const results = new Map<number, BatchMatchResult>();

  if (unmatchedRows.length === 0) return results;

  const anthropic = new Anthropic({
    apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  });

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

  const dirContextLines: string[] = [];
  for (const mapping of tabPatterns.directoryMappings.slice(0, 20)) {
    dirContextLines.push(`  ${mapping.lang.toUpperCase()}: ${mapping.sourceDir} → ${mapping.targetDir}`);
  }

  const batches: AiMatchInput[][] = [];
  for (let i = 0; i < unmatchedRows.length; i += AI_BATCH_SIZE) {
    batches.push(unmatchedRows.slice(i, i + AI_BATCH_SIZE));
  }

  const usedEnUrls = new Set<string>(knownEnUrls);
  const usedFrUrls = new Set<string>(knownFrUrls);
  let aiMatches = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    const batchEnUrls = new Set<string>();
    const batchFrUrls = new Set<string>();

    for (const row of batch) {
      if (row.needsEn && row.enDirectoryContext && enInventory) {
        const scoped = getScopedInventory(enInventory, row.enDirectoryContext, origin);
        for (const url of scoped.urls) {
          if (!usedEnUrls.has(url)) batchEnUrls.add(url);
        }
      }
      if (row.needsFr && row.frDirectoryContext && frInventory) {
        const scoped = getScopedInventory(frInventory, row.frDirectoryContext, origin);
        for (const url of scoped.urls) {
          if (!usedFrUrls.has(url)) batchFrUrls.add(url);
        }
      }
    }

    const needsEn = batch.some(r => r.needsEn);
    const needsFr = batch.some(r => r.needsFr);

    const batchTitles = batch
      .map(r => enTranslations.get(r.title) || frTranslations.get(r.title))
      .filter(Boolean) as string[];

    if (batchTitles.length > 0) {
      if (needsEn && enInventory) {
        const scopedBefore = batchEnUrls.size;
        const ranked = rankInventoryByTitleSimilarity(enInventory, batchTitles, usedEnUrls);
        for (const url of ranked) {
          if (!usedEnUrls.has(url)) batchEnUrls.add(url);
        }
        if (ranked.length > 0) {
          log(`    Title-supplement (EN): +${batchEnUrls.size - scopedBefore} title-ranked candidates added to ${scopedBefore} scoped (from ${enInventory.urls.size} total)`);
        }
      }
      if (needsFr && frInventory) {
        const scopedBefore = batchFrUrls.size;
        const ranked = rankInventoryByTitleSimilarity(frInventory, batchTitles, usedFrUrls);
        for (const url of ranked) {
          if (!usedFrUrls.has(url)) batchFrUrls.add(url);
        }
        if (ranked.length > 0) {
          log(`    Title-supplement (FR): +${batchFrUrls.size - scopedBefore} title-ranked candidates added to ${scopedBefore} scoped (from ${frInventory.urls.size} total)`);
        }
      }
    }

    if (batchEnUrls.size === 0 && needsEn && enInventory) {
      for (const url of enInventory.urls) {
        if (!usedEnUrls.has(url)) batchEnUrls.add(url);
      }
    }
    if (batchFrUrls.size === 0 && needsFr && frInventory) {
      for (const url of frInventory.urls) {
        if (!usedFrUrls.has(url)) batchFrUrls.add(url);
      }
    }

    const urlsBlock = batch.map(row => {
      const parts = [`- Source URL: ${row.sourceUrl}`];
      parts.push(`  Title (Hebrew): ${row.title || "N/A"}`);
      const enTitle = enTranslations.get(row.title);
      const frTitle = frTranslations.get(row.title);
      if (enTitle) parts.push(`  Title (English translation): ${enTitle}`);
      if (frTitle) parts.push(`  Title (French translation): ${frTitle}`);
      if (row.needsEn) parts.push(`  Needs: English URL`);
      if (row.needsFr) parts.push(`  Needs: French URL`);
      if (row.enDirectoryContext) parts.push(`  EN directory context: ${row.enDirectoryContext}`);
      if (row.frDirectoryContext) parts.push(`  FR directory context: ${row.frDirectoryContext}`);
      return parts.join("\n");
    }).join("\n\n");

    const enList = Array.from(batchEnUrls);
    const frList = Array.from(batchFrUrls);

    const enListStr = enList.length <= 500
      ? enList.join("\n")
      : enList.slice(0, 500).join("\n") + `\n... (${enList.length - 500} more)`;

    const frListStr = frList.length <= 500
      ? frList.join("\n")
      : frList.slice(0, 500).join("\n") + `\n... (${frList.length - 500} more)`;

    const systemPrompt = AI_SYSTEM_PROMPT_TEMPLATE
      .replace("{{patternContext}}", patternContext.join("\n"))
      .replace("{{directoryContext}}", dirContextLines.join("\n") || "(no directory mappings available)")
      .replace("{{exampleLines}}", exampleLines)
      .replace("{{usedEnUrls}}", Array.from(usedEnUrls).slice(-50).join("\n") || "(none)")
      .replace("{{usedFrUrls}}", Array.from(usedFrUrls).slice(-50).join("\n") || "(none)");

    const userPrompt = AI_USER_PROMPT_TEMPLATE
      .replace("{{urlsBlock}}", urlsBlock)
      .replace("{{enInventoryList}}", enListStr || "(no English inventory available)")
      .replace("{{frInventoryList}}", frListStr || "(no French inventory available)");

    try {
      log(`  AI batch ${batchIdx + 1}/${batches.length}: ${batch.length} URLs, inventory scope: ${enList.length} EN, ${frList.length} FR`);

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
