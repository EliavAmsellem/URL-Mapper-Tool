import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { storage } from "./storage";
import {
  learnTabPatterns,
  validateReferenceRows,
  crawlDirectory,
  buildInventoryFromDbRows,
  matchInDirectory,
  findTargetDirectory,
  getScopedInventory,
  titleMatchUnmatched,
  aiMatchUnmatched,
  batchTranslate,
  clearAllCaches,
  getAiConfig,
  crossLanguageDerive,
  type TabPatterns,
  type CrawlInventory,
  type BatchMatchResult,
  type ReferenceConflict,
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

  app.get("/api/ai-config", (_req: Request, res: Response) => {
    res.json(getAiConfig());
  });

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

      const control = { cancel: false, stopAfterCurrentRound: false };
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

  app.post("/api/jobs/:id/stop-ai", async (req: Request, res: Response) => {
    const control = activeJobs.get(req.params.id as string);
    if (!control) return res.status(404).json({ message: "No active job found" });
    control.stopAfterCurrentRound = true;
    log(`Stop-after-current-round requested for job ${req.params.id}`);
    res.json({ message: "Job will stop after the current AI round completes" });
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

  app.get("/api/jobs/:id/conflicts", async (req: Request, res: Response) => {
    try {
      const jobId = req.params.id as string;
      const job = await storage.getJob(jobId);
      if (!job) return res.status(404).json({ message: "Job not found" });

      const conflictsPath = `/tmp/uploads/${jobId}_conflicts.json`;
      if (!fs.existsSync(conflictsPath)) {
        return res.json([]);
      }

      const data = JSON.parse(fs.readFileSync(conflictsPath, "utf-8"));
      res.json(data);
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
        try { fs.unlinkSync(filePath); } catch {}
      });
    } catch (error: any) {
      log(`Download error: ${error.message}`);
      res.status(500).json({ message: error.message });
    }
  });

  setTimeout(async () => {
    try {
      const jobs = await storage.getAllJobs();
      for (const job of jobs) {
        if (job.status === "processing") {
          const cpPath = `/tmp/uploads/${job.id}_checkpoint.json`;
          if (fs.existsSync(cpPath) && fs.existsSync(`/tmp/uploads/${job.id}.xlsx`)) {
            log(`Auto-resuming interrupted job ${job.id} from checkpoint...`);
            const control = { cancel: false, stopAfterCurrentRound: false };
            activeJobs.set(job.id, control);
            processJob(job.id, 85, control).catch((err) => {
              log(`Auto-resume job error: ${err.message}`);
              storage.updateJob(job.id, { status: "error", currentStep: err.message });
            });
          }
        }
      }
    } catch (err: any) {
      log(`Auto-resume check error: ${err.message}`);
    }
  }, 3000);

  app.get("/api/crawl/sessions", async (_req: Request, res: Response) => {
    try {
      const sessions = await storage.getCrawlSessions();
      res.json(sessions);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/crawl/sessions/:id", async (req: Request, res: Response) => {
    try {
      const session = await storage.getCrawlSession(req.params.id);
      if (!session) return res.status(404).json({ message: "Session not found" });
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/crawl", async (req: Request, res: Response) => {
    try {
      const { origin, rootPath, label, maxPages, maxDepth } = req.body;
      if (!origin || !rootPath) {
        return res.status(400).json({ message: "origin and rootPath are required" });
      }

      const session = await storage.createCrawlSession({
        origin,
        rootPath,
        label: label || null,
        status: "pending",
        totalUrls: 0,
        maxPages: maxPages || 2000,
        maxDepth: maxDepth || 6,
      });

      runCrawlSession(session.id).catch(err => {
        log(`Crawl session ${session.id} error: ${err.message}`);
        storage.updateCrawlSession(session.id, { status: "failed" });
      });

      res.json(session);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/crawl/sessions/:id/refresh", async (req: Request, res: Response) => {
    try {
      const session = await storage.getCrawlSession(req.params.id);
      if (!session) return res.status(404).json({ message: "Session not found" });
      if (session.status === "crawling") return res.status(400).json({ message: "Crawl already in progress" });

      await storage.updateCrawlSession(session.id, { status: "pending", totalUrls: 0 });

      runCrawlSession(session.id).catch(err => {
        log(`Crawl refresh ${session.id} error: ${err.message}`);
        storage.updateCrawlSession(session.id, { status: "failed" });
      });

      const updated = await storage.getCrawlSession(session.id);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/crawl/sessions/:id", async (req: Request, res: Response) => {
    try {
      const session = await storage.getCrawlSession(req.params.id);
      if (!session) return res.status(404).json({ message: "Session not found" });
      if (session.status === "crawling") return res.status(400).json({ message: "Cannot delete while crawling" });
      await storage.deleteCrawlSession(session.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return httpServer;
}

async function runCrawlSession(sessionId: string) {
  const session = await storage.getCrawlSession(sessionId);
  if (!session) throw new Error("Session not found");

  await storage.updateCrawlSession(sessionId, {
    status: "crawling",
    startedAt: new Date(),
  } as any);

  log(`Starting crawl: ${session.origin}${session.rootPath} (maxPages=${session.maxPages}, maxDepth=${session.maxDepth})`);

  const rootPathParts = session.rootPath.split("/").filter(Boolean);

  const inventory = await crawlDirectory(
    session.origin,
    rootPathParts,
    (crawled, queued) => {
      if (crawled % 100 === 0) {
        log(`  Crawl progress: ${crawled} pages fetched, ${queued} queued`);
      }
    },
    { maxPages: session.maxPages || 2000, maxDepth: session.maxDepth || 6 }
  );

  const urlEntries = Array.from(inventory.urls).map(url => ({
    url,
    title: inventory.titleIndex.get(url) || undefined,
  }));

  await storage.saveCrawlInventory(sessionId, urlEntries);

  await storage.updateCrawlSession(sessionId, {
    status: "completed",
    totalUrls: urlEntries.length,
    completedAt: new Date(),
  } as any);

  log(`Crawl complete: ${session.origin}${session.rootPath} — ${urlEntries.length} URLs discovered and saved`);
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
  control: { cancel: boolean; stopAfterCurrentRound: boolean },
): Promise<{
  matchResults: Map<number, BatchMatchResult>;
  enInventory: CrawlInventory | null;
  frInventory: CrawlInventory | null;
  tabPatterns: TabPatterns;
  conflicts: ReferenceConflict[];
}> {
  const { sheetName, allRows, tabRefRows } = tabData;

  const { cleanedRows, conflicts } = validateReferenceRows(tabRefRows);
  const tabPatterns = learnTabPatterns(cleanedRows);
  log(`Tab "${sheetName}": ${tabRefRows.length} reference rows (${conflicts.length} conflicts flagged, ${cleanedRows.length} clean), ${allRows.length} total rows`);

  const needsMatching = allRows.filter((r) => r.needsEn || r.needsFr);
  const matchResults = new Map<number, BatchMatchResult>();
  let enInventory: CrawlInventory | null = null;
  let frInventory: CrawlInventory | null = null;

  const hasEnMappings = tabPatterns.enRoot.length > 0 || tabPatterns.directoryMappings.some(m => m.lang === "en");
  const hasFrMappings = tabPatterns.frRoot.length > 0 || tabPatterns.directoryMappings.some(m => m.lang === "fr");

  if (needsMatching.length === 0 || (!hasEnMappings && !hasFrMappings)) {
    return { matchResults, enInventory, frInventory, tabPatterns, conflicts };
  }

  const origin = (() => {
    for (const ref of tabRefRows) {
      try { return new URL(ref.sourceUrl).origin; } catch {}
    }
    for (const row of allRows) {
      try { return new URL(row.sourceUrl).origin; } catch {}
    }
    return "";
  })();

  function deriveCrawlRoot(lang: "en" | "fr"): string[] {
    const root = lang === "en" ? tabPatterns.enRoot : tabPatterns.frRoot;
    if (root.length > 0) return root;

    const langMappings = tabPatterns.directoryMappings.filter(m => m.lang === lang);
    if (langMappings.length === 0) return [];

    const targetDirParts = langMappings.map(m => m.targetDir.split("/").filter(Boolean));
    if (targetDirParts.length === 0) return [];
    if (targetDirParts.length === 1) return targetDirParts[0].slice(0, 2);

    const prefix: string[] = [];
    const minLen = Math.min(...targetDirParts.map(a => a.length));
    for (let i = 0; i < minLen; i++) {
      const first = targetDirParts[0][i].toLowerCase();
      if (targetDirParts.every(arr => arr[i].toLowerCase() === first)) {
        prefix.push(targetDirParts[0][i]);
      } else {
        break;
      }
    }
    return prefix.length > 0 ? prefix : targetDirParts[0].slice(0, 1);
  }

  const crawlPromises: Promise<void>[] = [];

  function getTargetDirs(lang: "en" | "fr"): string[] {
    const langMappings = tabPatterns.directoryMappings.filter(m => m.lang === lang);
    return [...new Set(langMappings.map(m => {
      const parts = m.targetDir.split("/").filter(Boolean);
      return "/" + parts.join("/");
    }))];
  }

  function filterSessionsByTargetDirs(sessions: { id: string; totalUrls: number; rootPath: string }[], targetDirs: string[], lang: string): { id: string; totalUrls: number; rootPath: string }[] {
    if (targetDirs.length === 0 || sessions.length <= 1) return sessions;

    const sessionScores = sessions.map(s => {
      const sessionRoot = s.rootPath.toLowerCase();
      const matchCount = targetDirs.filter(td => {
        const tdLower = td.toLowerCase();
        return sessionRoot === tdLower || sessionRoot.startsWith(tdLower + "/") || tdLower.startsWith(sessionRoot + "/");
      }).length;
      return { session: s, matchCount };
    });

    const maxScore = Math.max(...sessionScores.map(s => s.matchCount));
    if (maxScore === 0) return sessions;

    const threshold = Math.max(1, Math.floor(maxScore * 0.2));
    const filtered = sessionScores
      .filter(s => s.matchCount >= threshold)
      .map(s => s.session);

    if (filtered.length > 0 && filtered.length < sessions.length) {
      const excluded = sessions.filter(s => !filtered.includes(s));
      log(`  ${lang.toUpperCase()} inventory scoping: kept ${filtered.length} session(s) (score≥${threshold}), excluded ${excluded.length}: ${excluded.map(s => s.rootPath).join(", ")}`);
      return filtered;
    }
    return sessions;
  }

  if (origin && hasEnMappings) {
    const enCrawlRoot = deriveCrawlRoot("en");
    if (enCrawlRoot.length > 0) {
      const enCacheKey = `en:${enCrawlRoot.join("/")}`;
      if (crawlCache.has(enCacheKey)) {
        enInventory = crawlCache.get(enCacheKey)!;
        log(`  EN directory cached: ${enInventory.urls.size} URLs`);
      } else {
        const rootPathStr = "/" + enCrawlRoot.join("/");
        let dbSessions: { id: string; totalUrls: number; rootPath: string }[] = [];
        const exactSession = await storage.findCompletedCrawlSession(origin, rootPathStr);
        if (exactSession) {
          dbSessions = [exactSession];
        } else {
          const prefixSessions = await storage.findCompletedCrawlSessionsByPrefix(origin, rootPathStr);
          if (prefixSessions.length > 0) {
            dbSessions = filterSessionsByTargetDirs(prefixSessions, getTargetDirs("en"), "en");
          }
        }
        if (dbSessions.length > 0) {
          const allRows: { url: string; title: string | null }[] = [];
          for (const s of dbSessions) {
            const rows = await storage.loadCrawlInventory(s.id);
            allRows.push(...rows);
          }
          log(`  EN loading from DB inventory (${dbSessions.length} session(s)): ${allRows.length} URLs`);
          enInventory = buildInventoryFromDbRows(allRows);
          crawlCache.set(enCacheKey, enInventory);
          log(`  EN inventory loaded: ${enInventory.urls.size} URLs`);
        } else {
          log(`  Crawling EN directory: /${enCrawlRoot.join("/")}/`);
          crawlPromises.push(
            crawlDirectory(origin, enCrawlRoot, (c, q) => {
              if (c % 100 === 0) log(`    EN crawl progress: ${c} pages fetched, ${q} queued`);
            }).then(inv => { enInventory = inv; crawlCache.set(enCacheKey, inv); log(`  EN crawl complete: ${inv.urls.size} URLs discovered`); })
          );
        }
      }
    }
  }

  if (origin && hasFrMappings) {
    const frCrawlRoot = deriveCrawlRoot("fr");
    if (frCrawlRoot.length > 0) {
      const frCacheKey = `fr:${frCrawlRoot.join("/")}`;
      if (crawlCache.has(frCacheKey)) {
        frInventory = crawlCache.get(frCacheKey)!;
        log(`  FR directory cached: ${frInventory.urls.size} URLs`);
      } else {
        const rootPathStr = "/" + frCrawlRoot.join("/");
        let dbSessions: { id: string; totalUrls: number; rootPath: string }[] = [];
        const exactSession = await storage.findCompletedCrawlSession(origin, rootPathStr);
        if (exactSession) {
          dbSessions = [exactSession];
        } else {
          const prefixSessions = await storage.findCompletedCrawlSessionsByPrefix(origin, rootPathStr);
          if (prefixSessions.length > 0) {
            dbSessions = filterSessionsByTargetDirs(prefixSessions, getTargetDirs("fr"), "fr");
          }
        }
        if (dbSessions.length > 0) {
          const allRows: { url: string; title: string | null }[] = [];
          for (const s of dbSessions) {
            const rows = await storage.loadCrawlInventory(s.id);
            allRows.push(...rows);
          }
          log(`  FR loading from DB inventory (${dbSessions.length} session(s)): ${allRows.length} URLs`);
          frInventory = buildInventoryFromDbRows(allRows);
          crawlCache.set(frCacheKey, frInventory);
          log(`  FR inventory loaded: ${frInventory.urls.size} URLs`);
        } else {
          log(`  Crawling FR directory: /${frCrawlRoot.join("/")}/`);
          crawlPromises.push(
            crawlDirectory(origin, frCrawlRoot, (c, q) => {
              if (c % 100 === 0) log(`    FR crawl progress: ${c} pages fetched, ${q} queued`);
            }).then(inv => { frInventory = inv; crawlCache.set(frCacheKey, inv); log(`  FR crawl complete: ${inv.urls.size} URLs discovered`); })
          );
        }
      }
    }
  }

  if (crawlPromises.length > 0) await Promise.all(crawlPromises);

  for (const row of needsMatching) {
    if (control.cancel) break;
    const result: BatchMatchResult = {
      enUrl: null, frUrl: null,
      confidenceEn: null, confidenceFr: null,
      matchMethodEn: null, matchMethodFr: null,
    };

    if (row.needsEn && enInventory) {
      const targetDir = findTargetDirectory(row.sourceUrl, "en", tabPatterns);
      if (targetDir) {
        const scopedInv = getScopedInventory(enInventory, targetDir, origin);
        if (scopedInv.urls.size > 0) {
          const match = matchInDirectory(row.sourceUrl, "en", tabPatterns, scopedInv);
          if (match) {
            result.enUrl = match.url;
            result.confidenceEn = match.confidence;
            result.matchMethodEn = match.method;
          }
        }
      }
      if (!result.enUrl) {
        const match = matchInDirectory(row.sourceUrl, "en", tabPatterns, enInventory);
        if (match) {
          result.enUrl = match.url;
          result.confidenceEn = Math.max((match.confidence || 0) - 5, 70);
          result.matchMethodEn = match.method + "-broad";
        }
      }
    }

    if (row.needsFr && frInventory) {
      const targetDir = findTargetDirectory(row.sourceUrl, "fr", tabPatterns);
      if (targetDir) {
        const scopedInv = getScopedInventory(frInventory, targetDir, origin);
        if (scopedInv.urls.size > 0) {
          const match = matchInDirectory(row.sourceUrl, "fr", tabPatterns, scopedInv);
          if (match) {
            result.frUrl = match.url;
            result.confidenceFr = match.confidence;
            result.matchMethodFr = match.method;
          }
        }
      }
      if (!result.frUrl) {
        const match = matchInDirectory(row.sourceUrl, "fr", tabPatterns, frInventory);
        if (match) {
          result.frUrl = match.url;
          result.confidenceFr = Math.max((match.confidence || 0) - 5, 70);
          result.matchMethodFr = match.method + "-broad";
        }
      }
    }

    matchResults.set(row.rowIndex, result);
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

    const knownEnUrls = new Set<string>();
    const knownFrUrls = new Set<string>();

    for (const ref of tabRefRows) {
      if (ref.enUrl) knownEnUrls.add(ref.enUrl);
      if (ref.frUrl) knownFrUrls.add(ref.frUrl);
    }
    for (const [, mr] of Array.from(matchResults.entries())) {
      if (mr.enUrl) knownEnUrls.add(mr.enUrl);
      if (mr.frUrl) knownFrUrls.add(mr.frUrl);
    }

    log(`  Known URLs to exclude: ${knownEnUrls.size} EN, ${knownFrUrls.size} FR`);

    const groupedByDir = new Map<string, typeof unmatchedForTitle>();
    for (const row of unmatchedForTitle) {
      const enDir = row.needsEn ? findTargetDirectory(row.sourceUrl, "en", tabPatterns) : null;
      const frDir = row.needsFr ? findTargetDirectory(row.sourceUrl, "fr", tabPatterns) : null;
      const key = `${enDir || ""}|${frDir || ""}`;
      if (!groupedByDir.has(key)) groupedByDir.set(key, []);
      groupedByDir.get(key)!.push(row);
    }

    for (const [dirKey, rows] of groupedByDir) {
      const [enDir, frDir] = dirKey.split("|");

      let enScopedInv: CrawlInventory | null = null;
      let frScopedInv: CrawlInventory | null = null;

      if (enDir && enInventory) {
        enScopedInv = getScopedInventory(enInventory, enDir, origin);
        if (enScopedInv.urls.size === 0) enScopedInv = enInventory;
      } else if (enInventory) {
        enScopedInv = enInventory;
      }

      if (frDir && frInventory) {
        frScopedInv = getScopedInventory(frInventory, frDir, origin);
        if (frScopedInv.urls.size === 0) frScopedInv = frInventory;
      } else if (frInventory) {
        frScopedInv = frInventory;
      }

      const titleMatches = await titleMatchUnmatched(
        rows, enScopedInv, frScopedInv, storage,
        knownEnUrls, knownFrUrls,
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

  return { matchResults, enInventory, frInventory, tabPatterns, conflicts };
}

interface CheckpointData {
  globalMatchResults: Record<string, Record<string, BatchMatchResult>>;
  completedPhase: string;
  aiRound: number;
  matchedCount: number;
}

function saveCheckpoint(jobId: string, globalMatchResults: Map<string, Map<number, BatchMatchResult>>, phase: string, aiRound: number, matchedCount: number) {
  const data: CheckpointData = {
    globalMatchResults: {},
    completedPhase: phase,
    aiRound,
    matchedCount,
  };
  for (const [sheet, results] of Array.from(globalMatchResults.entries())) {
    const sheetResults: Record<string, BatchMatchResult> = {};
    for (const [rowIdx, result] of Array.from(results.entries())) {
      sheetResults[String(rowIdx)] = result;
    }
    data.globalMatchResults[sheet] = sheetResults;
  }
  const cpPath = `/tmp/uploads/${jobId}_checkpoint.json`;
  fs.writeFileSync(cpPath, JSON.stringify(data));
  log(`Checkpoint saved: phase=${phase} round=${aiRound} matches=${matchedCount}`);
}

function loadCheckpoint(jobId: string): CheckpointData | null {
  const cpPath = `/tmp/uploads/${jobId}_checkpoint.json`;
  if (!fs.existsSync(cpPath)) return null;
  try {
    const data: CheckpointData = JSON.parse(fs.readFileSync(cpPath, "utf-8"));
    log(`Checkpoint loaded: phase=${data.completedPhase} round=${data.aiRound} matches=${data.matchedCount}`);
    return data;
  } catch {
    return null;
  }
}

function restoreGlobalResults(checkpoint: CheckpointData): Map<string, Map<number, BatchMatchResult>> {
  const results = new Map<string, Map<number, BatchMatchResult>>();
  for (const [sheet, sheetResults] of Object.entries(checkpoint.globalMatchResults)) {
    const sheetMap = new Map<number, BatchMatchResult>();
    for (const [rowIdx, result] of Object.entries(sheetResults)) {
      sheetMap.set(Number(rowIdx), result);
    }
    results.set(sheet, sheetMap);
  }
  return results;
}

function clearCheckpoint(jobId: string) {
  const cpPath = `/tmp/uploads/${jobId}_checkpoint.json`;
  if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
}

async function processJob(jobId: string, _threshold: number, control: { cancel: boolean; stopAfterCurrentRound: boolean }) {
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

  const checkpoint = loadCheckpoint(jobId);
  let globalMatchResults = new Map<string, Map<number, BatchMatchResult>>();
  let resumeAiRound = 1;
  let skipToPostAi = false;

  if (checkpoint) {
    globalMatchResults = restoreGlobalResults(checkpoint);
    matchedCount = checkpoint.matchedCount;

    if (checkpoint.completedPhase === "structural") {
      resumeAiRound = 1;
      log(`Resuming from checkpoint after structural: ${matchedCount} matches, starting AI round 1`);
    } else if (checkpoint.completedPhase.startsWith("ai-round-")) {
      resumeAiRound = checkpoint.aiRound + 1;
      log(`Resuming from checkpoint after AI round ${checkpoint.aiRound}: ${matchedCount} matches, starting AI round ${resumeAiRound}`);
    } else if (checkpoint.completedPhase === "all-ai") {
      skipToPostAi = true;
      log(`Resuming from checkpoint: all AI done with ${matchedCount} matches, going to cross-language derivation`);
    }

    for (const tabData of allTabData) {
      const sheetResults = globalMatchResults.get(tabData.sheetName);
      if (!sheetResults) continue;
      for (const row of tabData.allRows) {
        const m = sheetResults.get(row.rowIndex);
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
    }
  }

  const tabInventories = new Map<string, { enInventory: CrawlInventory | null; frInventory: CrawlInventory | null; tabPatterns: TabPatterns }>();
  const allConflicts = new Map<string, ReferenceConflict[]>();

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (control.cancel) break;

    const passStartTime = Date.now();
    let passNewMatches = 0;

    if (pass > 1) {
      log(`\n========== PASS ${pass} ==========`);
      log(`Re-learning patterns from updated reference rows...`);

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

      const { matchResults, enInventory, frInventory, tabPatterns, conflicts } = await matchTab(tabData, crawlCache, control);
      tabInventories.set(tabData.sheetName, { enInventory, frInventory, tabPatterns });
      if (conflicts.length > 0) {
        if (!allConflicts.has(tabData.sheetName)) allConflicts.set(tabData.sheetName, []);
        allConflicts.get(tabData.sheetName)!.push(...conflicts);
      }

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

  saveCheckpoint(jobId, globalMatchResults, "structural", 1, matchedCount);

  const MAX_AI_ROUNDS = 3;

  for (let aiRound = skipToPostAi ? MAX_AI_ROUNDS + 1 : resumeAiRound; aiRound <= MAX_AI_ROUNDS && !control.cancel && !control.stopAfterCurrentRound; aiRound++) {
    const roundLabel = aiRound > 1 ? ` (round ${aiRound})` : "";
    await storage.updateJob(jobId, { currentStep: `ai-matching${roundLabel}` });

    if (aiRound > 1) {
      log(`\n========== AI RE-LEARNING ROUND ${aiRound} ==========`);
      log(`Feeding AI matches back as references and re-learning patterns...`);

      for (const tabData of allTabData) {
        const sheetGlobal = globalMatchResults.get(tabData.sheetName);
        if (!sheetGlobal) continue;

        for (const row of tabData.allRows) {
          const m = sheetGlobal.get(row.rowIndex);
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

      let reLearnNewMatches = 0;
      for (const tabData of allTabData) {
        if (control.cancel) break;
        const needsMatching = tabData.allRows.filter((r) => r.needsEn || r.needsFr);
        if (needsMatching.length === 0) continue;

        const inv = tabInventories.get(tabData.sheetName);
        if (!inv) continue;

        const { matchResults, tabPatterns } = await matchTab(tabData, crawlCache, control);
        tabInventories.set(tabData.sheetName, { ...inv, tabPatterns });

        const sheetGlobal = globalMatchResults.get(tabData.sheetName)!;
        let tabNew = 0;
        for (const [rowIndex, result] of Array.from(matchResults.entries())) {
          const existing = sheetGlobal.get(rowIndex);
          if (!existing) {
            if (result.enUrl || result.frUrl) {
              sheetGlobal.set(rowIndex, result);
              tabNew++;
            }
          } else {
            if (result.enUrl && !existing.enUrl) {
              existing.enUrl = result.enUrl;
              existing.confidenceEn = result.confidenceEn;
              existing.matchMethodEn = result.matchMethodEn;
              tabNew++;
            }
            if (result.frUrl && !existing.frUrl) {
              existing.frUrl = result.frUrl;
              existing.confidenceFr = result.confidenceFr;
              existing.matchMethodFr = result.matchMethodFr;
              tabNew++;
            }
          }
        }
        reLearnNewMatches += tabNew;
        matchedCount += tabNew;
        if (tabNew > 0) {
          log(`  Re-learn structural pass: ${tabNew} new matches for "${tabData.sheetName}"`);
        }
      }

      if (reLearnNewMatches > 0) {
        log(`Re-learn structural pass: ${reLearnNewMatches} total new matches`);
        await storage.updateJob(jobId, { matchedUrls: matchedCount });
      }
    }

    let roundAiTotal = 0;

    for (const tabData of allTabData) {
      if (control.cancel) break;

      const sheetGlobal = globalMatchResults.get(tabData.sheetName);
      const inv = tabInventories.get(tabData.sheetName);
      if (!sheetGlobal || !inv) continue;

      const unmatchedForAi = tabData.allRows.filter(row => {
        if (!row.title) return false;
        const m = sheetGlobal.get(row.rowIndex);
        const stillNeedsEn = row.needsEn && (!m || !m.enUrl);
        const stillNeedsFr = row.needsFr && (!m || !m.frUrl);
        return stillNeedsEn || stillNeedsFr;
      }).map(row => {
        const m = sheetGlobal.get(row.rowIndex);
        return {
          rowIndex: row.rowIndex,
          title: row.title,
          sourceUrl: row.sourceUrl,
          needsEn: row.needsEn && (!m || !m.enUrl),
          needsFr: row.needsFr && (!m || !m.frUrl),
          enDirectoryContext: findTargetDirectory(row.sourceUrl, "en", inv.tabPatterns) || undefined,
          frDirectoryContext: findTargetDirectory(row.sourceUrl, "fr", inv.tabPatterns) || undefined,
        };
      });

      if (unmatchedForAi.length === 0) continue;

      log(`\n=== AI Matching${roundLabel} for tab: "${tabData.sheetName}" (${unmatchedForAi.length} unmatched) ===`);
      await storage.updateJob(jobId, { currentStep: `ai:${tabData.sheetName}${roundLabel}` });

      const knownEnUrls = new Set<string>();
      const knownFrUrls = new Set<string>();
      for (const ref of tabData.tabRefRows) {
        if (ref.enUrl) knownEnUrls.add(ref.enUrl);
        if (ref.frUrl) knownFrUrls.add(ref.frUrl);
      }
      for (const [, mr] of Array.from(sheetGlobal.entries())) {
        if (mr.enUrl) knownEnUrls.add(mr.enUrl);
        if (mr.frUrl) knownFrUrls.add(mr.frUrl);
      }

      const matchedExamples = tabData.tabRefRows.slice(0, 10);

      const titlesForEn = unmatchedForAi.filter(r => r.needsEn).map(r => r.title).filter(Boolean);
      const titlesForFr = unmatchedForAi.filter(r => r.needsFr).map(r => r.title).filter(Boolean);

      let enTranslations = new Map<string, string>();
      let frTranslations = new Map<string, string>();

      if (titlesForEn.length > 0) {
        enTranslations = await batchTranslate(titlesForEn, "en", storage);
      }
      if (titlesForFr.length > 0) {
        frTranslations = await batchTranslate(titlesForFr, "fr", storage);
      }

      const origin = (() => {
        for (const ref of tabData.tabRefRows) {
          try { return new URL(ref.sourceUrl).origin; } catch {}
        }
        return "";
      })();

      const aiMatches = await aiMatchUnmatched(
        unmatchedForAi,
        inv.enInventory,
        inv.frInventory,
        inv.tabPatterns,
        matchedExamples,
        enTranslations,
        frTranslations,
        knownEnUrls,
        knownFrUrls,
        origin,
        control,
      );

      if (aiMatches.size > 0) {
        let aiAccepted = 0;

        for (const [rowIndex, aiResult] of Array.from(aiMatches.entries())) {
          if (aiResult.enUrl || aiResult.frUrl) {
            let existing = sheetGlobal.get(rowIndex);
            if (!existing) {
              existing = { enUrl: null, frUrl: null, confidenceEn: null, confidenceFr: null, matchMethodEn: null, matchMethodFr: null };
              sheetGlobal.set(rowIndex, existing);
            }
            if (aiResult.enUrl && !existing.enUrl) {
              existing.enUrl = aiResult.enUrl;
              existing.confidenceEn = aiResult.confidenceEn;
              existing.matchMethodEn = aiResult.matchMethodEn;
              aiAccepted++;
            }
            if (aiResult.frUrl && !existing.frUrl) {
              existing.frUrl = aiResult.frUrl;
              existing.confidenceFr = aiResult.confidenceFr;
              existing.matchMethodFr = aiResult.matchMethodFr;
              aiAccepted++;
            }
          }
        }

        roundAiTotal += aiAccepted;
        matchedCount += aiAccepted;
        log(`  AI results${roundLabel}: ${aiAccepted} accepted`);
        await storage.updateJob(jobId, { matchedUrls: matchedCount });
      }
    }

    log(`\nAI round ${aiRound}: ${roundAiTotal} total new matches`);

    saveCheckpoint(jobId, globalMatchResults, `ai-round-${aiRound}`, aiRound, matchedCount);

    if (roundAiTotal === 0) {
      log(`No new AI matches in round ${aiRound}, stopping AI re-learning loop.`);
      break;
    }

    if (control.stopAfterCurrentRound) {
      log(`Stop requested after AI round ${aiRound}. Finishing with ${matchedCount} matches.`);
      break;
    }
  }

  saveCheckpoint(jobId, globalMatchResults, "all-ai", MAX_AI_ROUNDS, matchedCount);

  if (!control.cancel) {
    log(`\n=== Cross-Language Derivation ===`);
    await storage.updateJob(jobId, { currentStep: "cross-lang" });

    let crossLangMatches = 0;
    for (const tabData of allTabData) {
      if (control.cancel) break;

      const sheetGlobal = globalMatchResults.get(tabData.sheetName);
      const inv = tabInventories.get(tabData.sheetName);
      if (!sheetGlobal || !inv) continue;

      const knownEnUrls = new Set<string>();
      const knownFrUrls = new Set<string>();
      for (const ref of tabData.tabRefRows) {
        if (ref.enUrl) knownEnUrls.add(ref.enUrl);
        if (ref.frUrl) knownFrUrls.add(ref.frUrl);
      }
      for (const [, mr] of Array.from(sheetGlobal.entries())) {
        if (mr.enUrl) knownEnUrls.add(mr.enUrl);
        if (mr.frUrl) knownFrUrls.add(mr.frUrl);
      }

      for (const row of tabData.allRows) {
        const m = sheetGlobal.get(row.rowIndex);
        if (!m) continue;

        if (m.frUrl && !m.enUrl && row.needsEn && inv.enInventory) {
          const derived = crossLanguageDerive(m.frUrl, "fr", "en", inv.tabPatterns, inv.enInventory, knownEnUrls);
          if (derived) {
            m.enUrl = derived.url;
            m.confidenceEn = derived.confidence;
            m.matchMethodEn = derived.method;
            knownEnUrls.add(derived.url);
            crossLangMatches++;
          }
        }

        if (m.enUrl && !m.frUrl && row.needsFr && inv.frInventory) {
          const derived = crossLanguageDerive(m.enUrl, "en", "fr", inv.tabPatterns, inv.frInventory, knownFrUrls);
          if (derived) {
            m.frUrl = derived.url;
            m.confidenceFr = derived.confidence;
            m.matchMethodFr = derived.method;
            knownFrUrls.add(derived.url);
            crossLangMatches++;
          }
        }
      }
    }

    if (crossLangMatches > 0) {
      matchedCount += crossLangMatches;
      log(`Cross-language derivation: ${crossLangMatches} new matches`);
      await storage.updateJob(jobId, { matchedUrls: matchedCount });
    } else {
      log(`Cross-language derivation: no new matches`);
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

  const conflictsList: (ReferenceConflict & { sheetName: string })[] = [];
  for (const [sheetName, sheetConflicts] of Array.from(allConflicts.entries())) {
    for (const c of sheetConflicts) {
      conflictsList.push({ ...c, sheetName });
    }
  }

  if (conflictsList.length > 0) {
    const conflictsPath = `/tmp/uploads/${jobId}_conflicts.json`;
    fs.writeFileSync(conflictsPath, JSON.stringify(conflictsList, null, 2));
    log(`Saved ${conflictsList.length} reference conflicts to ${conflictsPath}`);
  }

  await storage.updateJob(jobId, {
    status: control.cancel ? "cancelled" : "completed",
    processedUrls: totalUrls,
    matchedUrls: finalMatchedCount,
    currentStep: "done",
  });

  activeJobs.delete(jobId);
  clearAllCaches();
  clearCheckpoint(jobId);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\nJob ${jobId} completed in ${totalTime}s: ${finalMatchedCount} matches found out of ${totalUrls} URLs${conflictsList.length > 0 ? `, ${conflictsList.length} reference conflicts detected` : ""}`);
}
