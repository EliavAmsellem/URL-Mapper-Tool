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

const RATE_LIMIT_MS = 300;
let lastRequestTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

export async function fetchPageMetadata(url: string): Promise<PageMetadata | null> {
  try {
    await rateLimit();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

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
      log(`Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const parsedUrl = new URL(url);
    const slug = parsedUrl.pathname.toLowerCase().replace(/\/+$/, "");

    return {
      title: $("title").text().trim() || "",
      ogTitle: $('meta[property="og:title"]').attr("content")?.trim() || "",
      h1: $("h1").first().text().trim() || "",
      breadcrumbDepth: $(".breadcrumb li, .breadcrumbs li, nav[aria-label*='breadcrumb'] li, .ms-breadcrumb-dropdownMenu").length || slug.split("/").filter(Boolean).length,
      bodyClasses: $("body").attr("class")?.trim() || "",
      slug,
      lang: $("html").attr("lang") || "",
    };
  } catch (error: any) {
    log(`Scrape error for ${url}: ${error.message}`);
    return null;
  }
}

function slugTokens(slug: string): string[] {
  return slug
    .split("/")
    .filter(Boolean)
    .flatMap((segment) => segment.split(/[-_]/))
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

export interface MatchScore {
  total: number;
  slugScore: number;
  titleScore: number;
  structureScore: number;
  method: "slug" | "meta" | "structure" | "mixed";
}

export function computeMatchScore(
  source: PageMetadata,
  candidate: PageMetadata
): MatchScore {
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

  return {
    total: Math.round(total),
    slugScore: Math.round(slugScore),
    titleScore: Math.round(titleScore),
    structureScore: Math.round(structureScore),
    method,
  };
}

export function inferLanguageUrl(sourceUrl: string, targetLang: "en" | "fr" | "ru" | "ar"): string[] {
  const candidates: string[] = [];
  try {
    const parsed = new URL(sourceUrl);
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    const langPrefixMap: Record<string, string[]> = {
      en: ["English%20Homepage", "English Homepage", "en"],
      fr: ["French%20homepage", "French homepage", "fr"],
      ru: ["Russian%20homepage", "Russian homepage", "ru"],
      ar: ["Arabic%20homepage", "Arabic homepage", "ar"],
    };

    const hebrewSegmentMap: Record<string, Record<string, string>> = {
      en: {},
      fr: {},
      ru: {},
      ar: {},
    };

    const prefixes = langPrefixMap[targetLang] || [targetLang];

    for (const prefix of prefixes) {
      const newPath = "/" + prefix + "/" + pathParts.slice(1).join("/");
      candidates.push(parsed.origin + newPath);
    }

    if (pathParts.length > 1) {
      for (const prefix of prefixes) {
        const newPath = "/" + prefix + "/" + pathParts.slice(2).join("/");
        if (newPath !== "/" + prefix + "/") {
          candidates.push(parsed.origin + newPath);
        }
      }
    }

    const basePath = parsed.pathname;
    for (const prefix of prefixes) {
      if (!basePath.toLowerCase().includes(prefix.toLowerCase())) {
        candidates.push(parsed.origin + "/" + prefix + basePath);
      }
    }
  } catch {
  }

  return Array.from(new Set(candidates));
}

export async function findBestMatch(
  sourceUrl: string,
  sourceMeta: PageMetadata | null,
  targetLang: "en" | "fr" | "ru" | "ar",
  confidenceThreshold: number = 85
): Promise<{ url: string; score: MatchScore } | null> {
  const candidateUrls = inferLanguageUrl(sourceUrl, targetLang);

  if (!sourceMeta) {
    sourceMeta = await fetchPageMetadata(sourceUrl);
  }
  if (!sourceMeta) return null;

  let bestMatch: { url: string; score: MatchScore } | null = null;

  for (const candidateUrl of candidateUrls) {
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