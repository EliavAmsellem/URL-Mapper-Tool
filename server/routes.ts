import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { storage } from "./storage";
import {
  learnTabPatterns,
  batchConstructUrls,
  constructTargetUrl,
  validatePatterns,
  batchHeadCheck,
  crawlDirectory,
  matchAgainstInventory,
  titleMatchUnmatched,
  clearCaches,
  clearAllCaches,
  type TabPatterns,
  type CrawlInventory,
  type BatchMatchResult,
} from "./scraper";
import { log } from "./index";

const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls", ".csv"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel and CSV files are allowed"));
    }
  },
});

const activeJobs = new Map<string, { cancel: boolean }>();

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/upload", upload.single("file"), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const workbook = XLSX.readFile(req.file.path);
      let totalUrls = 0;

      for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
        totalUrls += Math.max(0, data.length - 1);
      }

      const langStr = typeof req.body?.languages === "string" ? req.body.languages : "";
      const targetLangs = langStr ? langStr.split(",") : ["en", "fr"];

      const job = await storage.createJob({
        fileName: req.file.originalname,
        status: "pending",
        totalUrls,
        processedUrls: 0,
        matchedUrls: 0,
        targetLanguages: targetLangs,
        currentStep: "idle",
      });

      if (!fs.existsSync("/tmp/uploads")) {
        fs.mkdirSync("/tmp/uploads", { recursive: true });
      }
      fs.copyFileSync(req.file.path, `/tmp/uploads/${job.id}.xlsx`);
      fs.unlinkSync(req.file.path);

      res.json({ jobId: job.id, totalUrls, sheets: workbook.SheetNames });
    } catch (error: any) {
      log(`Upload error: ${error.message}`);
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/jobs/:id/start", async (req: Request, res: Response) => {
    try {
      const jobId = req.params.id as string;
      const job = await storage.getJob(jobId);
      if (!job) return res.status(404).json({ message: "Job not found" });

      const threshold = parseInt(req.body?.threshold as string) || 85;

      for (const [existingJobId, existingControl] of Array.from(activeJobs.entries())) {
        if (existingJobId !== jobId) {
          log(`Cancelling previous job ${existingJobId} before starting new job ${jobId}`);
          existingControl.cancel = true;
          await storage.updateJob(existingJobId, { status: "cancelled", currentStep: "done" });
          activeJobs.delete(existingJobId);
        }
      }

      const control = { cancel: false };
      activeJobs.set(jobId, control);

      await storage.updateJob(jobId, { status: "processing", currentStep: "learning" });

      res.json({ message: "Processing started" });

      processJob(jobId, threshold, control).catch((err) => {
        log(`Job processing error: ${err.message}`);
        storage.updateJob(jobId, { status: "error", currentStep: err.message });
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/jobs/:id", async (req: Request, res: Response) => {
    try {
      const job = await storage.getJob(req.params.id as string);
      if (!job) return res.status(404).json({ message: "Job not found" });
      res.json(job);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/jobs/:id/results", async (req: Request, res: Response) => {
    try {
      const results = await storage.getResultsByJob(req.params.id as string);
      res.json(results);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/jobs/:id/download", async (req: Request, res: Response) => {
    try {
      const jobId = req.params.id as string;
      const job = await storage.getJob(jobId);
      if (!job) return res.status(404).json({ message: "Job not found" });

      const filePath = `/tmp/uploads/${jobId}.xlsx`;
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "Source file not found" });
      }

      const workbook = XLSX.readFile(filePath);
      const results = await storage.getResultsByJob(jobId);

      const resultMap = new Map<string, Map<number, typeof results[0]>>();
      for (const r of results) {
        if (!resultMap.has(r.sheetName)) {
          resultMap.set(r.sheetName, new Map());
        }
        resultMap.get(r.sheetName)!.set(r.rowIndex, r);
      }

      for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
        const sheetResults = resultMap.get(sheetName);
        if (!sheetResults) continue;

        for (let i = 1; i < data.length; i++) {
          const result = sheetResults.get(i);
          if (!result) continue;

          while (data[i].length < 6) data[i].push("");

          if (result.englishUrl && !data[i][2]) {
            data[i][2] = result.englishUrl;
          }
          if (result.frenchUrl && !data[i][3]) {
            data[i][3] = result.frenchUrl;
          }
          if (result.russianUrl && !data[i][4]) {
            data[i][4] = result.russianUrl;
          }
          if (result.arabicUrl && !data[i][5]) {
            data[i][5] = result.arabicUrl;
          }
        }

        workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(data);
      }

      const outputPath = `/tmp/uploads/${jobId}_output.xlsx`;
      XLSX.writeFile(workbook, outputPath);

      const outputName = job.fileName.replace(/\.xlsx?$/i, "_mapped.xlsx");
      res.download(outputPath, outputName, () => {
        try { fs.unlinkSync(outputPath); } catch {}
      });
    } catch (error: any) {
      log(`Download error: ${error.message}`);
      res.status(500).json({ message: error.message });
    }
  });

  return httpServer;
}

const DB_BATCH_SIZE = 200;
const MAX_PASSES = 3;

interface RowData {
  rowIndex: number;
  title: string;
  sourceUrl: string;
  existingEn: string;
  existingFr: string;
  originalEn: string;
  originalFr: string;
  needsEn: boolean;
  needsFr: boolean;
}

interface TabData {
  sheetName: string;
  allRows: RowData[];
  tabRefRows: { sourceUrl: string; enUrl?: string; frUrl?: string }[];
  data: any[][];
}

function parseSheet(
  sheetName: string,
  ws: XLSX.WorkSheet,
  targetLangs: string[]
): TabData | null {
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
  if (data.length < 2) return null;

  const tabRefRows: { sourceUrl: string; enUrl?: string; frUrl?: string }[] = [];
  const allRows: RowData[] = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const title = (row[0] || "").toString().trim();
    const rawSource = (row[1] || "").toString().trim();
    const existingEn = (row[2] || "").toString().trim();
    const existingFr = (row[3] || "").toString().trim();

    let sourceUrl = rawSource;
    if (!sourceUrl.startsWith("http") && sourceUrl.includes("|")) {
      const afterPipe = sourceUrl.split("|").pop()?.trim() || "";
      if (afterPipe.startsWith("http")) sourceUrl = afterPipe;
    }

    if (!sourceUrl || !sourceUrl.startsWith("http")) continue;

    if (existingEn || existingFr) {
      tabRefRows.push({
        sourceUrl,
        enUrl: existingEn || undefined,
        frUrl: existingFr || undefined,
      });
    }

    const needsEn = targetLangs.includes("en") && !existingEn;
    const needsFr = targetLangs.includes("fr") && !existingFr;

    allRows.push({ rowIndex: i, title, sourceUrl, existingEn, existingFr, originalEn: existingEn, originalFr: existingFr, needsEn, needsFr });
  }

  return { sheetName, allRows, tabRefRows, data };
}

async function matchTab(
  tabData: TabData,
  crawlCache: Map<string, CrawlInventory>,
  control: { cancel: boolean },
): Promise<{
  matchResults: Map<number, BatchMatchResult>;
  enInventory: CrawlInventory | null;
  frInventory: CrawlInventory | null;
  tabPatterns: TabPatterns;
}> {
  const { sheetName, allRows, tabRefRows } = tabData;

  const tabPatterns = learnTabPatterns(tabRefRows);
  log(`Tab "${sheetName}": ${tabRefRows.length} reference rows, ${allRows.length} total rows`);

  const needsMatching = allRows.filter((r) => r.needsEn || r.needsFr);
  const matchResults = new Map<number, BatchMatchResult>();
  let enInventory: CrawlInventory | null = null;
  let frInventory: CrawlInventory | null = null;

  if (needsMatching.length === 0 || (tabPatterns.enRoot.length === 0 && tabPatterns.frRoot.length === 0)) {
    return { matchResults, enInventory, frInventory, tabPatterns };
  }

  if (tabPatterns.enRoot.length > 0) tabPatterns.patternValidated.en = true;
  if (tabPatterns.frRoot.length > 0) tabPatterns.patternValidated.fr = true;

  const origin = (() => {
    for (const ref of tabRefRows) {
      try { return new URL(ref.sourceUrl).origin; } catch {}
    }
    for (const row of allRows) {
      try { return new URL(row.sourceUrl).origin; } catch {}
    }
    return "";
  })();

  const crawlPromises: Promise<void>[] = [];
  if (origin && tabPatterns.enRoot.length > 0) {
    const enScope = tabPatterns.enCrawlScope.length > 0 ? tabPatterns.enCrawlScope : tabPatterns.enRoot;
    const enCacheKey = `en:${enScope.join("/")}`;
    if (crawlCache.has(enCacheKey)) {
      enInventory = crawlCache.get(enCacheKey)!;
      log(`  EN directory cached: ${enInventory.urls.size} URLs`);
    } else {
      log(`  Crawling EN directory: /${enScope.join("/")}/`);
      crawlPromises.push(
        crawlDirectory(origin, enScope, (c, q) => {
          if (c % 50 === 0) log(`    EN crawl progress: ${c} pages fetched, ${q} queued`);
        }).then(inv => { enInventory = inv; crawlCache.set(enCacheKey, inv); log(`  EN crawl complete: ${inv.urls.size} URLs discovered`); })
      );
    }
  }

  if (origin && tabPatterns.frRoot.length > 0) {
    const frScope = tabPatterns.frCrawlScope.length > 0 ? tabPatterns.frCrawlScope : tabPatterns.frRoot;
    const frCacheKey = `fr:${frScope.join("/")}`;
    if (crawlCache.has(frCacheKey)) {
      frInventory = crawlCache.get(frCacheKey)!;
      log(`  FR directory cached: ${frInventory.urls.size} URLs`);
    } else {
      log(`  Crawling FR directory: /${frScope.join("/")}/`);
      crawlPromises.push(
        crawlDirectory(origin, frScope, (c, q) => {
          if (c % 50 === 0) log(`    FR crawl progress: ${c} pages fetched, ${q} queued`);
        }).then(inv => { frInventory = inv; crawlCache.set(frCacheKey, inv); log(`  FR crawl complete: ${inv.urls.size} URLs discovered`); })
      );
    }
  }

  if (crawlPromises.length > 0) await Promise.all(crawlPromises);

  const unmatchedForHead: { index: number; lang: "en" | "fr"; constructedUrl: string; sourceUrl: string }[] = [];
  for (const row of needsMatching) {
    if (control.cancel) break;
    const result: BatchMatchResult = {
      enUrl: null, frUrl: null,
      confidenceEn: null, confidenceFr: null,
      matchMethodEn: null, matchMethodFr: null,
    };

    if (row.needsEn && tabPatterns.patternValidated.en && enInventory) {
      const match = matchAgainstInventory(row.sourceUrl, "en", tabPatterns, enInventory);
      if (match) {
        result.enUrl = match.url;
        result.confidenceEn = match.confidence;
        result.matchMethodEn = match.method;
      } else {
        const constructed = constructTargetUrl(row.sourceUrl, "en", tabPatterns);
        if (constructed) unmatchedForHead.push({ index: row.rowIndex, lang: "en", constructedUrl: constructed, sourceUrl: row.sourceUrl });
      }
    }

    if (row.needsFr && tabPatterns.patternValidated.fr && frInventory) {
      const match = matchAgainstInventory(row.sourceUrl, "fr", tabPatterns, frInventory);
      if (match) {
        result.frUrl = match.url;
        result.confidenceFr = match.confidence;
        result.matchMethodFr = match.method;
      } else {
        const constructed = constructTargetUrl(row.sourceUrl, "fr", tabPatterns);
        if (constructed) unmatchedForHead.push({ index: row.rowIndex, lang: "fr", constructedUrl: constructed, sourceUrl: row.sourceUrl });
      }
    }

    matchResults.set(row.rowIndex, result);
  }

  if (unmatchedForHead.length > 0) {
    log(`  Falling back to HEAD checks for ${unmatchedForHead.length} unmatched URLs...`);
    const headUrls = unmatchedForHead.map((u) => u.constructedUrl);
    const existence = await batchHeadCheck(headUrls);
    let headMatched = 0;
    let headDepthRejected = 0;
    const enSrcRoot = tabPatterns.enSrcRoot;
    const frSrcRoot = tabPatterns.frSrcRoot;
    const enTgtRoot = tabPatterns.enRoot;
    const frTgtRoot = tabPatterns.frRoot;

    for (const item of unmatchedForHead) {
      if (existence.get(item.constructedUrl)) {
        const srcRoot = item.lang === "en" ? enSrcRoot : frSrcRoot;
        const tgtRoot = item.lang === "en" ? enTgtRoot : frTgtRoot;

        try {
          const srcParts = new URL(item.sourceUrl).pathname.split("/").filter(Boolean);
          const srcDepth = srcParts.length - srcRoot.length;
          const tgtParts = new URL(item.constructedUrl).pathname.split("/").filter(Boolean);
          const tgtDepth = tgtParts.length - tgtRoot.length;
          if (srcDepth >= 2 && tgtDepth <= 0) {
            log(`    HEAD match REJECTED (parent-only): ${item.sourceUrl} -> ${item.constructedUrl}`);
            headDepthRejected++;
            continue;
          }
          if (srcDepth >= 3 && tgtDepth <= 1) {
            log(`    HEAD match REJECTED (too shallow): ${item.sourceUrl} -> ${item.constructedUrl}`);
            headDepthRejected++;
            continue;
          }
        } catch {}

        const result = matchResults.get(item.index);
        if (result) {
          if (item.lang === "en") {
            result.enUrl = item.constructedUrl;
            result.confidenceEn = 90;
            result.matchMethodEn = "pattern+head";
          } else {
            result.frUrl = item.constructedUrl;
            result.confidenceFr = 90;
            result.matchMethodFr = "pattern+head";
          }
          headMatched++;
        }
      }
    }
    log(`  HEAD fallback: ${headMatched}/${unmatchedForHead.length} verified${headDepthRejected > 0 ? `, ${headDepthRejected} depth-rejected` : ''}`);
  }

  const unmatchedForTitle = needsMatching.filter(row => {
    const m = matchResults.get(row.rowIndex);
    return row.title && (
      (row.needsEn && (!m || !m.enUrl)) ||
      (row.needsFr && (!m || !m.frUrl))
    );
  }).map(row => {
    const m = matchResults.get(row.rowIndex);
    return {
      rowIndex: row.rowIndex,
      title: row.title,
      sourceUrl: row.sourceUrl,
      needsEn: row.needsEn && (!m || !m.enUrl),
      needsFr: row.needsFr && (!m || !m.frUrl),
    };
  });

  if (unmatchedForTitle.length > 0 && (enInventory || frInventory)) {
    log(`  Attempting title-based matching for ${unmatchedForTitle.length} unmatched URLs...`);

    const enAllowedRoots = new Set<string>();
    const frAllowedRoots = new Set<string>();

    if (tabPatterns.enRoot.length > 0) {
      enAllowedRoots.add("/" + tabPatterns.enRoot.join("/") + "/");
    }
    if (tabPatterns.frRoot.length > 0) {
      frAllowedRoots.add("/" + tabPatterns.frRoot.join("/") + "/");
    }

    for (const ref of tabRefRows) {
      if (ref.enUrl) {
        try {
          const enPath = new URL(ref.enUrl).pathname;
          const enParts = enPath.split("/").filter(Boolean);
          if (enParts.length >= 2) {
            enAllowedRoots.add("/" + enParts.slice(0, 2).join("/") + "/");
          } else if (enParts.length >= 1) {
            enAllowedRoots.add("/" + enParts[0] + "/");
          }
        } catch {}
      }
      if (ref.frUrl) {
        try {
          const frPath = new URL(ref.frUrl).pathname;
          const frParts = frPath.split("/").filter(Boolean);
          if (frParts.length >= 2) {
            frAllowedRoots.add("/" + frParts.slice(0, 2).join("/") + "/");
          } else if (frParts.length >= 1) {
            frAllowedRoots.add("/" + frParts[0] + "/");
          }
        } catch {}
      }
    }

    const enRootsArr = Array.from(enAllowedRoots);
    const frRootsArr = Array.from(frAllowedRoots);
    if (enRootsArr.length > 0) log(`  EN allowed roots for title matching: ${enRootsArr.join(", ")}`);
    else log(`  EN title matching SKIPPED: no allowed roots could be determined`);
    if (frRootsArr.length > 0) log(`  FR allowed roots for title matching: ${frRootsArr.join(", ")}`);
    else log(`  FR title matching SKIPPED: no allowed roots could be determined`);

    const enRefDepths: number[] = [];
    const frRefDepths: number[] = [];
    const knownEnUrls = new Set<string>();
    const knownFrUrls = new Set<string>();

    for (const ref of tabRefRows) {
      if (ref.enUrl) {
        try {
          enRefDepths.push(new URL(ref.enUrl).pathname.split("/").filter(Boolean).length);
          knownEnUrls.add(ref.enUrl);
        } catch {}
      }
      if (ref.frUrl) {
        try {
          frRefDepths.push(new URL(ref.frUrl).pathname.split("/").filter(Boolean).length);
          knownFrUrls.add(ref.frUrl);
        } catch {}
      }
    }

    for (const [, mr] of Array.from(matchResults.entries())) {
      if (mr.enUrl) knownEnUrls.add(mr.enUrl);
      if (mr.frUrl) knownFrUrls.add(mr.frUrl);
    }

    if (enRefDepths.length > 0) log(`  EN ref depths: min=${Math.min(...enRefDepths)} max=${Math.max(...enRefDepths)} (${enRefDepths.length} refs)`);
    if (frRefDepths.length > 0) log(`  FR ref depths: min=${Math.min(...frRefDepths)} max=${Math.max(...frRefDepths)} (${frRefDepths.length} refs)`);
    log(`  Known URLs to exclude: ${knownEnUrls.size} EN, ${knownFrUrls.size} FR`);

    const titleMatches = await titleMatchUnmatched(
      unmatchedForTitle, enInventory, frInventory, storage,
      enRootsArr,
      frRootsArr,
      enRefDepths.length > 0 ? enRefDepths : undefined,
      frRefDepths.length > 0 ? frRefDepths : undefined,
      knownEnUrls,
      knownFrUrls,
    );

    for (const [rowIndex, titleResult] of Array.from(titleMatches.entries())) {
      let result = matchResults.get(rowIndex);
      if (!result) {
        result = { enUrl: null, frUrl: null, confidenceEn: null, confidenceFr: null, matchMethodEn: null, matchMethodFr: null };
        matchResults.set(rowIndex, result);
      }
      if (titleResult.enUrl && !result.enUrl) {
        result.enUrl = titleResult.enUrl;
        result.confidenceEn = titleResult.confidenceEn;
        result.matchMethodEn = titleResult.matchMethodEn;
      }
      if (titleResult.frUrl && !result.frUrl) {
        result.frUrl = titleResult.frUrl;
        result.confidenceFr = titleResult.confidenceFr;
        result.matchMethodFr = titleResult.matchMethodFr;
      }
    }
  }

  let dedupEn = 0;
  let dedupFr = 0;

  const sourceUrlByRow = new Map<number, string>();
  for (const row of needsMatching) {
    sourceUrlByRow.set(row.rowIndex, row.sourceUrl);
  }

  function normalizeSourceForDedup(url: string): string {
    try {
      const parsed = new URL(url);
      let path = decodeURIComponent(parsed.pathname).toLowerCase().replace(/\/+$/, "");
      if (path.endsWith("/default.aspx")) path = path.slice(0, -"/default.aspx".length);
      if (path.endsWith("/pages")) path = path.slice(0, -"/pages".length);
      return parsed.origin + path;
    } catch { return url.toLowerCase(); }
  }

  function dedupLang(lang: "en" | "fr") {
    const urlToRows = new Map<string, { rowIndex: number; confidence: number; normSource: string }[]>();
    for (const [rowIndex, result] of Array.from(matchResults.entries())) {
      const targetUrl = lang === "en" ? result.enUrl : result.frUrl;
      const conf = lang === "en" ? result.confidenceEn : result.confidenceFr;
      if (!targetUrl) continue;
      if (!urlToRows.has(targetUrl)) urlToRows.set(targetUrl, []);
      const srcUrl = sourceUrlByRow.get(rowIndex) || "";
      urlToRows.get(targetUrl)!.push({ rowIndex, confidence: conf || 0, normSource: normalizeSourceForDedup(srcUrl) });
    }

    let count = 0;
    for (const [url, rows] of Array.from(urlToRows.entries())) {
      if (rows.length <= 1) continue;

      const uniqueSources = new Set(rows.map(r => r.normSource));
      if (uniqueSources.size <= 1) continue;

      rows.sort((a, b) => b.confidence - a.confidence);
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].normSource === rows[0].normSource) continue;
        const result = matchResults.get(rows[i].rowIndex);
        if (result) {
          if (lang === "en" && result.enUrl === url) {
            log(`    Dedup EN REJECTED: ${url} for row ${rows[i].rowIndex} (kept for row ${rows[0].rowIndex})`);
            result.enUrl = null;
            result.confidenceEn = null;
            result.matchMethodEn = null;
            count++;
          } else if (lang === "fr" && result.frUrl === url) {
            log(`    Dedup FR REJECTED: ${url} for row ${rows[i].rowIndex} (kept for row ${rows[0].rowIndex})`);
            result.frUrl = null;
            result.confidenceFr = null;
            result.matchMethodFr = null;
            count++;
          }
        }
      }
    }
    return count;
  }

  dedupEn = dedupLang("en");
  dedupFr = dedupLang("fr");

  if (dedupEn > 0 || dedupFr > 0) {
    log(`  Deduplication removed ${dedupEn} EN and ${dedupFr} FR duplicate target assignments`);
  }

  return { matchResults, enInventory, frInventory, tabPatterns };
}

async function processJob(jobId: string, _threshold: number, control: { cancel: boolean }) {
  const filePath = `/tmp/uploads/${jobId}.xlsx`;
  if (!fs.existsSync(filePath)) {
    throw new Error("Source file not found");
  }

  clearAllCaches();

  const workbook = XLSX.readFile(filePath);
  const job = await storage.getJob(jobId);
  if (!job) throw new Error("Job not found");

  const targetLangs = (job.targetLanguages || ["en", "fr"]) as string[];
  let processedCount = 0;
  let matchedCount = 0;
  const startTime = Date.now();
  const crawlCache = new Map<string, CrawlInventory>();

  const allTabData: TabData[] = [];
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const td = parseSheet(sheetName, ws, targetLangs);
    if (td) allTabData.push(td);
  }

  const globalMatchResults = new Map<string, Map<number, BatchMatchResult>>();

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (control.cancel) break;

    const passStartTime = Date.now();
    let passNewMatches = 0;

    if (pass > 1) {
      log(`\n========== PASS ${pass} ==========`);
      log(`Re-learning patterns from ${pass === 1 ? "original" : "updated"} reference rows...`);

      for (const tabData of allTabData) {
        const prevResults = globalMatchResults.get(tabData.sheetName);
        if (!prevResults) continue;

        for (const row of tabData.allRows) {
          const m = prevResults.get(row.rowIndex);
          if (!m) continue;
          if (m.enUrl && row.needsEn) {
            row.existingEn = m.enUrl;
            row.needsEn = false;
          }
          if (m.frUrl && row.needsFr) {
            row.existingFr = m.frUrl;
            row.needsFr = false;
          }
        }

        tabData.tabRefRows = [];
        for (const row of tabData.allRows) {
          if (row.existingEn || row.existingFr) {
            tabData.tabRefRows.push({
              sourceUrl: row.sourceUrl,
              enUrl: row.existingEn || undefined,
              frUrl: row.existingFr || undefined,
            });
          }
        }
      }
    }

    for (const tabData of allTabData) {
      if (control.cancel) break;

      const needsMatching = tabData.allRows.filter((r) => r.needsEn || r.needsFr);
      if (needsMatching.length === 0) {
        if (pass === 1) {
          log(`\n=== Processing tab: "${tabData.sheetName}" (${tabData.allRows.length} rows) ===`);
          log(`Tab "${tabData.sheetName}": all rows already have matches, skipping`);
        }
        continue;
      }

      const tabStartTime = Date.now();
      log(`\n=== ${pass > 1 ? `Pass ${pass} - ` : ""}Processing tab: "${tabData.sheetName}" (${needsMatching.length} unmatched) ===`);

      const stepLabel = pass > 1 ? `pass${pass}:${tabData.sheetName}` : `matching:${tabData.sheetName}`;
      await storage.updateJob(jobId, { currentStep: stepLabel });

      const { matchResults } = await matchTab(tabData, crawlCache, control);

      if (!globalMatchResults.has(tabData.sheetName)) {
        globalMatchResults.set(tabData.sheetName, new Map());
      }
      const sheetGlobal = globalMatchResults.get(tabData.sheetName)!;

      let tabNewMatches = 0;
      for (const [rowIndex, result] of Array.from(matchResults.entries())) {
        const existing = sheetGlobal.get(rowIndex);
        if (!existing) {
          if (result.enUrl || result.frUrl) {
            sheetGlobal.set(rowIndex, result);
            tabNewMatches++;
          }
        } else {
          if (result.enUrl && !existing.enUrl) {
            existing.enUrl = result.enUrl;
            existing.confidenceEn = result.confidenceEn;
            existing.matchMethodEn = result.matchMethodEn;
            tabNewMatches++;
          }
          if (result.frUrl && !existing.frUrl) {
            existing.frUrl = result.frUrl;
            existing.confidenceFr = result.confidenceFr;
            existing.matchMethodFr = result.matchMethodFr;
            tabNewMatches++;
          }
        }
      }

      passNewMatches += tabNewMatches;
      processedCount += tabData.allRows.length;
      matchedCount += tabNewMatches;

      await storage.updateJob(jobId, {
        processedUrls: processedCount,
        matchedUrls: matchedCount,
      });

      const tabTime = ((Date.now() - tabStartTime) / 1000).toFixed(1);
      log(`Tab "${tabData.sheetName}" done in ${tabTime}s: ${tabNewMatches} new matches this pass`);
    }

    const passTime = ((Date.now() - passStartTime) / 1000).toFixed(1);
    log(`\nPass ${pass} completed in ${passTime}s: ${passNewMatches} new matches`);

    if (pass > 1 && passNewMatches === 0) {
      log(`No new matches in pass ${pass}, stopping multi-pass.`);
      break;
    }

    if (pass < MAX_PASSES && passNewMatches > 0) {
      for (const tabData of allTabData) {
        const prevResults = globalMatchResults.get(tabData.sheetName);
        if (!prevResults) continue;
        for (const row of tabData.allRows) {
          const m = prevResults.get(row.rowIndex);
          if (!m) continue;
          if (m.enUrl && row.needsEn) {
            row.existingEn = m.enUrl;
            row.needsEn = false;
          }
          if (m.frUrl && row.needsFr) {
            row.existingFr = m.frUrl;
            row.needsFr = false;
          }
        }
        tabData.tabRefRows = [];
        for (const row of tabData.allRows) {
          if (row.existingEn || row.existingFr) {
            tabData.tabRefRows.push({
              sourceUrl: row.sourceUrl,
              enUrl: row.existingEn || undefined,
              frUrl: row.existingFr || undefined,
            });
          }
        }
      }
    }
  }

  await storage.updateJob(jobId, { currentStep: "saving" });

  await storage.deleteResultsByJob(jobId);

  let finalMatchedCount = 0;

  for (const tabData of allTabData) {
    if (control.cancel) break;

    const sheetGlobal = globalMatchResults.get(tabData.sheetName) || new Map();
    const resultBatch: any[] = [];

    for (const row of tabData.allRows) {
      if (control.cancel) break;

      const match = sheetGlobal.get(row.rowIndex);
      let enUrl: string | null = row.originalEn || null;
      let frUrl: string | null = row.originalFr || null;
      let confidenceEn: number | null = null;
      let confidenceFr: number | null = null;
      let matchMethodEn: string | null = row.originalEn ? "existing" : null;
      let matchMethodFr: string | null = row.originalFr ? "existing" : null;

      if (match) {
        let rowHasMatch = false;
        if (match.enUrl && !row.originalEn) {
          enUrl = match.enUrl;
          confidenceEn = match.confidenceEn;
          matchMethodEn = match.matchMethodEn;
          rowHasMatch = true;
        }
        if (match.frUrl && !row.originalFr) {
          frUrl = match.frUrl;
          confidenceFr = match.confidenceFr;
          matchMethodFr = match.matchMethodFr;
          rowHasMatch = true;
        }
        if (rowHasMatch) finalMatchedCount++;
      }

      resultBatch.push({
        jobId,
        sheetName: tabData.sheetName,
        rowIndex: row.rowIndex,
        title: row.title,
        sourceUrl: row.sourceUrl,
        englishUrl: enUrl,
        frenchUrl: frUrl,
        russianUrl: null,
        arabicUrl: null,
        confidenceEn,
        confidenceFr,
        matchMethodEn,
        matchMethodFr,
        details: {},
      });

      if (resultBatch.length >= DB_BATCH_SIZE) {
        await storage.createResults(resultBatch);
        resultBatch.length = 0;
      }
    }

    if (resultBatch.length > 0) {
      await storage.createResults(resultBatch);
      resultBatch.length = 0;
    }
  }

  const totalUrls = allTabData.reduce((sum, t) => sum + t.allRows.length, 0);

  await storage.updateJob(jobId, {
    status: control.cancel ? "cancelled" : "completed",
    processedUrls: totalUrls,
    matchedUrls: finalMatchedCount,
    currentStep: "done",
  });

  activeJobs.delete(jobId);
  clearAllCaches();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\nJob ${jobId} completed in ${totalTime}s: ${finalMatchedCount} matches found out of ${totalUrls} URLs`);
}
