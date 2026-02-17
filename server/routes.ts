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
  clearCaches,
  type TabPatterns,
  type CrawlInventory,
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
      res.download(outputPath, outputName);
    } catch (error: any) {
      log(`Download error: ${error.message}`);
      res.status(500).json({ message: error.message });
    }
  });

  return httpServer;
}

const DB_BATCH_SIZE = 200;
const SAMPLE_SIZE = 5;

async function processJob(jobId: string, _threshold: number, control: { cancel: boolean }) {
  const filePath = `/tmp/uploads/${jobId}.xlsx`;
  if (!fs.existsSync(filePath)) {
    throw new Error("Source file not found");
  }

  clearCaches();

  const workbook = XLSX.readFile(filePath);
  const job = await storage.getJob(jobId);
  if (!job) throw new Error("Job not found");

  const targetLangs = (job.targetLanguages || ["en", "fr"]) as ("en" | "fr" | "ru" | "ar")[];
  let processedCount = 0;
  let matchedCount = 0;
  const startTime = Date.now();
  const crawlCache = new Map<string, CrawlInventory>();

  for (const sheetName of workbook.SheetNames) {
    if (control.cancel) break;

    const ws = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
    if (data.length < 2) continue;

    const tabStartTime = Date.now();
    log(`\n=== Processing tab: "${sheetName}" (${data.length - 1} rows) ===`);
    await storage.updateJob(jobId, { currentStep: "learning" });

    const tabRefRows: { sourceUrl: string; enUrl?: string; frUrl?: string }[] = [];
    const allRows: {
      rowIndex: number;
      title: string;
      sourceUrl: string;
      existingEn: string;
      existingFr: string;
      needsEn: boolean;
      needsFr: boolean;
    }[] = [];

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

      allRows.push({ rowIndex: i, title, sourceUrl, existingEn, existingFr, needsEn, needsFr });
    }

    const tabPatterns = learnTabPatterns(tabRefRows);
    log(`Tab "${sheetName}": ${tabRefRows.length} reference rows, ${allRows.length} total rows`);

    const needsMatching = allRows.filter((r) => r.needsEn || r.needsFr);

    if (needsMatching.length > 0 && (tabPatterns.enRoot.length > 0 || tabPatterns.frRoot.length > 0)) {
      await storage.updateJob(jobId, { currentStep: "matching" });

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

      let enInventory: CrawlInventory | null = null;
      let frInventory: CrawlInventory | null = null;

      const crawlPromises: Promise<void>[] = [];
      if (origin && tabPatterns.enRoot.length > 0) {
        const enScope = tabPatterns.enCrawlScope.length > 0 ? tabPatterns.enCrawlScope : tabPatterns.enRoot;
        const enCacheKey = `en:${enScope.join("/")}`;
        if (crawlCache.has(enCacheKey)) {
          enInventory = crawlCache.get(enCacheKey)!;
          log(`  EN directory cached: ${enInventory.urls.size} URLs (/${enScope.join("/")})`);
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
          log(`  FR directory cached: ${frInventory.urls.size} URLs (/${frScope.join("/")})`);
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

      const matchResults = new Map<number, { enUrl: string | null; frUrl: string | null; confidenceEn: number | null; confidenceFr: number | null; matchMethodEn: string | null; matchMethodFr: string | null }>();
      const unmatchedForHead: { index: number; lang: "en" | "fr"; constructedUrl: string }[] = [];
      for (const row of needsMatching) {
        const result = {
          enUrl: null as string | null,
          frUrl: null as string | null,
          confidenceEn: null as number | null,
          confidenceFr: null as number | null,
          matchMethodEn: null as string | null,
          matchMethodFr: null as string | null,
        };

        if (row.needsEn && tabPatterns.patternValidated.en) {
          if (enInventory) {
            const match = matchAgainstInventory(row.sourceUrl, "en", tabPatterns, enInventory);
            if (match) {
              result.enUrl = match.url;
              result.confidenceEn = match.confidence;
              result.matchMethodEn = match.method;
            } else {
              const constructed = constructTargetUrl(row.sourceUrl, "en", tabPatterns);
              if (constructed) unmatchedForHead.push({ index: row.rowIndex, lang: "en", constructedUrl: constructed });
            }
          }
        }

        if (row.needsFr && tabPatterns.patternValidated.fr) {
          if (frInventory) {
            const match = matchAgainstInventory(row.sourceUrl, "fr", tabPatterns, frInventory);
            if (match) {
              result.frUrl = match.url;
              result.confidenceFr = match.confidence;
              result.matchMethodFr = match.method;
            } else {
              const constructed = constructTargetUrl(row.sourceUrl, "fr", tabPatterns);
              if (constructed) unmatchedForHead.push({ index: row.rowIndex, lang: "fr", constructedUrl: constructed });
            }
          }
        }

        matchResults.set(row.rowIndex, result);
      }

      if (unmatchedForHead.length > 0) {
        log(`  Falling back to HEAD checks for ${unmatchedForHead.length} unmatched URLs...`);
        const headUrls = unmatchedForHead.map((u) => u.constructedUrl);
        const existence = await batchHeadCheck(headUrls);
        let headMatched = 0;
        for (const item of unmatchedForHead) {
          if (existence.get(item.constructedUrl)) {
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
        log(`  HEAD fallback: ${headMatched}/${unmatchedForHead.length} verified`);
      }

      const crawlMatched = Array.from(matchResults.values()).reduce((acc, m) => {
        return acc + (m.enUrl ? 1 : 0) + (m.frUrl ? 1 : 0);
      }, 0);
      log(`  Total matches for tab: ${crawlMatched}`);

      const resultBatch: any[] = [];

      for (const row of allRows) {
        if (control.cancel) break;
        processedCount++;

        if (!row.needsEn && !row.needsFr) {
          resultBatch.push({
            jobId,
            sheetName,
            rowIndex: row.rowIndex,
            title: row.title,
            sourceUrl: row.sourceUrl,
            englishUrl: row.existingEn || null,
            frenchUrl: row.existingFr || null,
            russianUrl: null,
            arabicUrl: null,
            confidenceEn: null,
            confidenceFr: null,
            matchMethodEn: row.existingEn ? "existing" : null,
            matchMethodFr: row.existingFr ? "existing" : null,
            details: {},
          });
        } else {
          const match = matchResults.get(row.rowIndex);

          let enUrl: string | null = row.existingEn || null;
          let frUrl: string | null = row.existingFr || null;
          let confidenceEn: number | null = null;
          let confidenceFr: number | null = null;
          let matchMethodEn: string | null = null;
          let matchMethodFr: string | null = null;

          if (match) {
            if (match.enUrl && row.needsEn) {
              enUrl = match.enUrl;
              confidenceEn = match.confidenceEn;
              matchMethodEn = match.matchMethodEn;
              matchedCount++;
            }
            if (match.frUrl && row.needsFr) {
              frUrl = match.frUrl;
              confidenceFr = match.confidenceFr;
              matchMethodFr = match.matchMethodFr;
              matchedCount++;
            }
          }

          resultBatch.push({
            jobId,
            sheetName,
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
        }

        if (resultBatch.length >= DB_BATCH_SIZE) {
          await storage.createResults(resultBatch);
          resultBatch.length = 0;
          await storage.updateJob(jobId, {
            processedUrls: processedCount,
            matchedUrls: matchedCount,
            currentStep: "matching",
          });
        }
      }

      if (resultBatch.length > 0) {
        await storage.createResults(resultBatch);
        resultBatch.length = 0;
      }
    } else {
      for (const row of allRows) {
        if (control.cancel) break;
        processedCount++;
      }
    }

    await storage.updateJob(jobId, {
      processedUrls: processedCount,
      matchedUrls: matchedCount,
      currentStep: "matching",
    });

    const tabTime = ((Date.now() - tabStartTime) / 1000).toFixed(1);
    log(`Tab "${sheetName}" done in ${tabTime}s: ${matchedCount} matches so far`);
  }

  await storage.updateJob(jobId, {
    status: control.cancel ? "cancelled" : "completed",
    processedUrls: processedCount,
    matchedUrls: matchedCount,
    currentStep: "done",
  });

  activeJobs.delete(jobId);
  clearCaches();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\nJob ${jobId} completed in ${totalTime}s: ${matchedCount} matches found out of ${processedCount} URLs`);
}
