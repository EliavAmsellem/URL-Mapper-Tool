import * as cheerio from "cheerio";
import { log } from "./index";

export interface PageMetadata {
  title: string;
  ogTitle: string;
  h1: string;
  breadcrumbDepth: number;
  bodyClasses: string;
  slug: string;
  lang: string;
}

export interface MatchScore {
  total: number;
  slugScore: number;
  titleScore: number;
  structureScore: number;
  method: "slug" | "meta" | "structure" | "mixed" | "pattern";
}

export interface UrlPattern {
  sourcePrefix: string;
  targetPrefix: string;
  lang: string;
}

const RATE_LIMIT_MS = 200;
let lastRequestTime = 0;
const metadataCache = new Map<string, PageMetadata | null>();
const urlExistenceCache = new Map<string, boolean>();

export function clearCaches() {
  metadataCache.clear();
  urlExistenceCache.clear();
}

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

export async function checkUrlExists(url: string): Promise<boolean> {
  if (urlExistenceCache.has(url)) return urlExistenceCache.get(url)!;
  try {
    await rateLimit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
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

export async function fetchPageMetadata(url: string): Promise<PageMetadata | null> {
  if (metadataCache.has(url)) return metadataCache.get(url)!;
  try {
    await rateLimit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinguaMap/1.0; URL Mapper Bot)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en,fr,ru,ar",
      },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!response.ok) {
      metadataCache.set(url, null);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const parsedUrl = new URL(url);
    const slug = parsedUrl.pathname.toLowerCase().replace(/\/+$/, "");

    const meta: PageMetadata = {
      title: $("title").text().trim() || "",
      ogTitle: $('meta[property="og:title"]').attr("content")?.trim() || "",
      h1: $("h1").first().text().trim() || "",
      breadcrumbDepth: $(".breadcrumb li, .breadcrumbs li, nav[aria-label*='breadcrumb'] li, .ms-breadcrumb-dropdownMenu").length || slug.split("/").filter(Boolean).length,
      bodyClasses: $("body").attr("class")?.trim() || "",
      slug,
      lang: $("html").attr("lang") || "",
    };
    metadataCache.set(url, meta);
    return meta;
  } catch (error: any) {
    metadataCache.set(url, null);
    return null;
  }
}

function slugTokens(slug: string): string[] {
  return slug
    .split("/")
    .filter(Boolean)
    .flatMap((segment) => decodeURIComponent(segment).split(/[-_\s]+/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersectionCount = 0;
  setA.forEach((x) => { if (setB.has(x)) intersectionCount++; });
  const unionCount = new Set(a.concat(b)).size;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (normA === normB) return 1;
  const tokensA = normA.split(" ");
  const tokensB = normB.split(" ");
  return jaccardSimilarity(tokensA, tokensB);
}

export function computeMatchScore(source: PageMetadata, candidate: PageMetadata): MatchScore {
  const SLUG_WEIGHT = 0.3;
  const TITLE_WEIGHT = 0.5;
  const STRUCTURE_WEIGHT = 0.2;

  const slugScore = jaccardSimilarity(slugTokens(source.slug), slugTokens(candidate.slug)) * 100;
  const titleSim = Math.max(
    textSimilarity(source.title, candidate.title),
    textSimilarity(source.ogTitle, candidate.ogTitle),
    textSimilarity(source.h1, candidate.h1)
  );
  const titleScore = titleSim * 100;

  let structureScore = 0;
  if (source.breadcrumbDepth > 0 && candidate.breadcrumbDepth > 0) {
    const depthDiff = Math.abs(source.breadcrumbDepth - candidate.breadcrumbDepth);
    structureScore = Math.max(0, 100 - depthDiff * 25);
  }
  const sourceClasses = source.bodyClasses.split(" ").filter(Boolean);
  const candidateClasses = candidate.bodyClasses.split(" ").filter(Boolean);
  if (sourceClasses.length > 0 && candidateClasses.length > 0) {
    const classSim = jaccardSimilarity(sourceClasses, candidateClasses) * 100;
    structureScore = Math.max(structureScore, classSim);
  }

  const total = slugScore * SLUG_WEIGHT + titleScore * TITLE_WEIGHT + structureScore * STRUCTURE_WEIGHT;

  let method: MatchScore["method"] = "mixed";
  const dominant = Math.max(slugScore * SLUG_WEIGHT, titleScore * TITLE_WEIGHT, structureScore * STRUCTURE_WEIGHT);
  if (dominant === slugScore * SLUG_WEIGHT) method = "slug";
  else if (dominant === titleScore * TITLE_WEIGHT) method = "meta";
  else if (dominant === structureScore * STRUCTURE_WEIGHT) method = "structure";

  return { total: Math.round(total), slugScore: Math.round(slugScore), titleScore: Math.round(titleScore), structureScore: Math.round(structureScore), method };
}

export function learnPatternsFromExistingMappings(
  rows: { sourceUrl: string; enUrl?: string; frUrl?: string }[]
): UrlPattern[] {
  const patterns: UrlPattern[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    try {
      const sourceParsed = new URL(row.sourceUrl);
      const sourceParts = sourceParsed.pathname.split("/").filter(Boolean);
      if (sourceParts.length === 0) continue;

      if (row.enUrl) {
        const enParsed = new URL(row.enUrl);
        if (enParsed.origin === sourceParsed.origin) {
          const enParts = enParsed.pathname.split("/").filter(Boolean);
          if (enParts.length > 0) {
            const key = `en:${sourceParts[0]}:${enParts[0]}`;
            if (!seen.has(key)) {
              seen.add(key);
              patterns.push({
                sourcePrefix: sourceParts[0],
                targetPrefix: enParts[0],
                lang: "en",
              });
            }
          }
        }
      }

      if (row.frUrl) {
        const frParsed = new URL(row.frUrl);
        if (frParsed.origin === sourceParsed.origin) {
          const frParts = frParsed.pathname.split("/").filter(Boolean);
          if (frParts.length > 0) {
            const key = `fr:${sourceParts[0]}:${frParts[0]}`;
            if (!seen.has(key)) {
              seen.add(key);
              patterns.push({
                sourcePrefix: sourceParts[0],
                targetPrefix: frParts[0],
                lang: "fr",
              });
            }
          }
        }
      }
    } catch {}
  }

  log(`Learned ${patterns.length} URL patterns from existing mappings`);
  return patterns;
}

export function learnSegmentMappings(
  rows: { sourceUrl: string; enUrl?: string; frUrl?: string }[]
): Map<string, Map<string, string>> {
  const segmentMap = new Map<string, Map<string, string>>();
  segmentMap.set("en", new Map());
  segmentMap.set("fr", new Map());

  for (const row of rows) {
    try {
      const sourceParsed = new URL(row.sourceUrl);
      const sourceParts = sourceParsed.pathname.split("/").filter(Boolean);

      if (row.enUrl) {
        const enParsed = new URL(row.enUrl);
        const enParts = enParsed.pathname.split("/").filter(Boolean);
        const enMap = segmentMap.get("en")!;
        for (let i = 0; i < Math.min(sourceParts.length, enParts.length); i++) {
          const sDecoded = decodeURIComponent(sourceParts[i]).toLowerCase();
          const tDecoded = decodeURIComponent(enParts[i]).toLowerCase();
          if (sDecoded !== tDecoded) {
            enMap.set(sDecoded, enParts[i]);
          }
        }
      }

      if (row.frUrl) {
        const frParsed = new URL(row.frUrl);
        const frParts = frParsed.pathname.split("/").filter(Boolean);
        const frMap = segmentMap.get("fr")!;
        for (let i = 0; i < Math.min(sourceParts.length, frParts.length); i++) {
          const sDecoded = decodeURIComponent(sourceParts[i]).toLowerCase();
          const tDecoded = decodeURIComponent(frParts[i]).toLowerCase();
          if (sDecoded !== tDecoded) {
            frMap.set(sDecoded, frParts[i]);
          }
        }
      }
    } catch {}
  }

  const enSize = segmentMap.get("en")?.size || 0;
  const frSize = segmentMap.get("fr")?.size || 0;
  log(`Learned ${enSize} EN segment mappings and ${frSize} FR segment mappings`);
  return segmentMap;
}

export function inferLanguageUrlWithPatterns(
  sourceUrl: string,
  targetLang: "en" | "fr" | "ru" | "ar",
  patterns: UrlPattern[],
  segmentMap: Map<string, Map<string, string>>
): string[] {
  const candidates: string[] = [];
  try {
    const parsed = new URL(sourceUrl);
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    const langPatterns = patterns.filter((p) => p.lang === targetLang);
    const segments = segmentMap.get(targetLang);

    for (const pattern of langPatterns) {
      const decodedFirst = decodeURIComponent(pathParts[0] || "").toLowerCase();
      const decodedPattern = decodeURIComponent(pattern.sourcePrefix).toLowerCase();
      if (decodedFirst === decodedPattern || pathParts[0] === pattern.sourcePrefix) {
        const newParts = [pattern.targetPrefix, ...pathParts.slice(1)];
        if (segments) {
          for (let i = 1; i < newParts.length; i++) {
            const decoded = decodeURIComponent(newParts[i]).toLowerCase();
            if (segments.has(decoded)) {
              newParts[i] = segments.get(decoded)!;
            }
          }
        }
        candidates.push(parsed.origin + "/" + newParts.join("/"));
      }
    }

    if (segments && pathParts.length > 0) {
      const translatedParts = pathParts.map((part) => {
        const decoded = decodeURIComponent(part).toLowerCase();
        return segments.has(decoded) ? segments.get(decoded)! : part;
      });
      const translatedUrl = parsed.origin + "/" + translatedParts.join("/");
      if (translatedUrl !== sourceUrl) {
        candidates.push(translatedUrl);
      }
    }

    const langPrefixMap: Record<string, string[]> = {
      en: ["English%20Homepage", "en"],
      fr: ["French%20homepage", "fr"],
      ru: ["Russian%20homepage", "ru"],
      ar: ["Arabic%20homepage", "ar"],
    };

    const prefixes = langPrefixMap[targetLang] || [targetLang];
    for (const prefix of prefixes) {
      candidates.push(parsed.origin + "/" + prefix + "/" + pathParts.slice(1).join("/"));
    }

    if (pathParts.length > 1) {
      for (const prefix of prefixes) {
        const restPath = pathParts.slice(2).join("/");
        if (restPath) {
          candidates.push(parsed.origin + "/" + prefix + "/" + restPath);
        }
      }
    }
  } catch {}

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const normalized = c.replace(/\/+$/, "");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(c);
    }
  }
  return unique;
}

export async function findBestMatchOptimized(
  sourceUrl: string,
  sourceMeta: PageMetadata | null,
  targetLang: "en" | "fr" | "ru" | "ar",
  patterns: UrlPattern[],
  segmentMap: Map<string, Map<string, string>>,
  confidenceThreshold: number = 85
): Promise<{ url: string; score: MatchScore } | null> {
  const candidateUrls = inferLanguageUrlWithPatterns(sourceUrl, targetLang, patterns, segmentMap);

  if (candidateUrls.length === 0) return null;

  const existChecks = await Promise.all(
    candidateUrls.slice(0, 6).map(async (url) => ({
      url,
      exists: await checkUrlExists(url),
    }))
  );

  const validCandidates = existChecks.filter((c) => c.exists).map((c) => c.url);

  if (validCandidates.length === 0) return null;

  if (!sourceMeta) {
    sourceMeta = await fetchPageMetadata(sourceUrl);
  }
  if (!sourceMeta) {
    if (validCandidates.length > 0) {
      return {
        url: validCandidates[0],
        score: { total: 90, slugScore: 90, titleScore: 0, structureScore: 0, method: "pattern" },
      };
    }
    return null;
  }

  let bestMatch: { url: string; score: MatchScore } | null = null;

  for (const candidateUrl of validCandidates.slice(0, 3)) {
    const candidateMeta = await fetchPageMetadata(candidateUrl);
    if (!candidateMeta) continue;

    const score = computeMatchScore(sourceMeta, candidateMeta);

    if (!bestMatch || score.total > bestMatch.score.total) {
      bestMatch = { url: candidateUrl, score };
    }
    if (score.total >= 90) break;
  }

  if (bestMatch && bestMatch.score.total < confidenceThreshold) {
    return null;
  }

  return bestMatch;
}