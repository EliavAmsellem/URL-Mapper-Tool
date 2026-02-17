import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { storage } from "./storage";
import {
  fetchPageMetadata,
  findBestMatchOptimized,
  learnPatternsFromExistingMappings,
  learnSegmentMappings,
  clearCaches,
  type UrlPattern,
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

      await storage.updateJob(jobId, { status: "processing", currentStep: "slug" });

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

async function processJob(jobId: string, threshold: number, control: { cancel: boolean }) {
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

  await storage.updateJob(jobId, { currentStep: "learning" });
  log("Phase 1: Learning URL patterns from existing mappings...");

  const referenceRows: { sourceUrl: string; enUrl?: string; frUrl?: string }[] = [];
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const sourceUrl = (row[1] || "").toString().trim();
      const enUrl = (row[2] || "").toString().trim();
      const frUrl = (row[3] || "").toString().trim();
      if (sourceUrl && sourceUrl.startsWith("http") && (enUrl || frUrl)) {
        referenceRows.push({
          sourceUrl,
          enUrl: enUrl || undefined,
          frUrl: frUrl || undefined,
        });
      }
    }
  }

  const patterns = learnPatternsFromExistingMappings(referenceRows);
  const segmentMap = learnSegmentMappings(referenceRows);

  log(`Phase 1 complete: ${referenceRows.length} reference rows, ${patterns.length} patterns learned`);
  await storage.updateJob(jobId, { currentStep: "slug" });

  const resultBatch: any[] = [];
  const BATCH_SIZE = 50;
  const STATUS_UPDATE_INTERVAL = 5;

  for (const sheetName of workbook.SheetNames) {
    if (control.cancel) break;

    const ws = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
    if (data.length < 2) continue;

    for (let i = 1; i < data.length; i++) {
      if (control.cancel) break;

      const row = data[i];
      const title = (row[0] || "").toString().trim();
      const sourceUrl = (row[1] || "").toString().trim();
      const existingEn = (row[2] || "").toString().trim();
      const existingFr = (row[3] || "").toString().trim();

      processedCount++;

      if (!sourceUrl || !sourceUrl.startsWith("http")) {
        continue;
      }

      const needsEn = targetLangs.includes("en") && !existingEn;
      const needsFr = targetLangs.includes("fr") && !existingFr;

      if (!needsEn && !needsFr) {
        resultBatch.push({
          jobId,
          sheetName,
          rowIndex: i,
          title,
          sourceUrl,
          englishUrl: existingEn || null,
          frenchUrl: existingFr || null,
          russianUrl: null,
          arabicUrl: null,
          confidenceEn: null,
          confidenceFr: null,
          matchMethodEn: existingEn ? "existing" : null,
          matchMethodFr: existingFr ? "existing" : null,
          details: {},
        });

        if (resultBatch.length >= BATCH_SIZE) {
          await storage.createResults(resultBatch);
          resultBatch.length = 0;
        }

        if (processedCount % STATUS_UPDATE_INTERVAL === 0) {
          await storage.updateJob(jobId, { processedUrls: processedCount, matchedUrls: matchedCount });
        }
        continue;
      }

      const progress = processedCount / job.totalUrls;
      const currentStep = progress < 0.35 ? "slug" : progress < 0.75 ? "meta" : "structure";
      if (processedCount % STATUS_UPDATE_INTERVAL === 0) {
        await storage.updateJob(jobId, { currentStep, processedUrls: processedCount, matchedUrls: matchedCount });
      }

      let sourceMeta = null;
      try {
        sourceMeta = await fetchPageMetadata(sourceUrl);
      } catch (e: any) {}

      let enUrl: string | null = existingEn || null;
      let frUrl: string | null = existingFr || null;
      let confidenceEn: number | null = null;
      let confidenceFr: number | null = null;
      let matchMethodEn: string | null = null;
      let matchMethodFr: string | null = null;
      let details: any = {};

      if (needsEn) {
        const enMatch = await findBestMatchOptimized(sourceUrl, sourceMeta, "en", patterns, segmentMap, threshold);
        if (enMatch) {
          enUrl = enMatch.url;
          confidenceEn = enMatch.score.total;
          matchMethodEn = enMatch.score.method;
          details.en = enMatch.score;
          matchedCount++;
        }
      }

      if (needsFr) {
        const frMatch = await findBestMatchOptimized(sourceUrl, sourceMeta, "fr", patterns, segmentMap, threshold);
        if (frMatch) {
          frUrl = frMatch.url;
          confidenceFr = frMatch.score.total;
          matchMethodFr = frMatch.score.method;
          details.fr = frMatch.score;
          matchedCount++;
        }
      }

      resultBatch.push({
        jobId,
        sheetName,
        rowIndex: i,
        title,
        sourceUrl,
        englishUrl: enUrl,
        frenchUrl: frUrl,
        russianUrl: null,
        arabicUrl: null,
        confidenceEn,
        confidenceFr,
        matchMethodEn,
        matchMethodFr,
        details,
      });

      if (resultBatch.length >= BATCH_SIZE) {
        await storage.createResults(resultBatch);
        resultBatch.length = 0;
      }

      if (processedCount % 20 === 0) {
        log(`Processed ${processedCount}/${job.totalUrls} (${matchedCount} matches)`);
      }
    }
  }

  if (resultBatch.length > 0) {
    await storage.createResults(resultBatch);
  }

  await storage.updateJob(jobId, {
    status: control.cancel ? "cancelled" : "completed",
    processedUrls: processedCount,
    matchedUrls: matchedCount,
    currentStep: "done",
  });

  activeJobs.delete(jobId);
  clearCaches();
  log(`Job ${jobId} completed: ${matchedCount} matches found out of ${processedCount} URLs`);
}