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
  validatePatterns,
  batchHeadCheck,
  clearCaches,
  type TabPatterns,
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

      const sampleUrls: { sourceUrl: string; lang: "en" | "fr" }[] = [];
      const sampleCount = Math.min(SAMPLE_SIZE, needsMatching.length);
      const step = Math.max(1, Math.floor(needsMatching.length / sampleCount));
      for (let i = 0; i < sampleCount; i++) {
        const row = needsMatching[i * step];
        if (row.needsEn && tabPatterns.enRoot.length > 0) {
          sampleUrls.push({ sourceUrl: row.sourceUrl, lang: "en" });
        }
        if (row.needsFr && tabPatterns.frRoot.length > 0) {
          sampleUrls.push({ sourceUrl: row.sourceUrl, lang: "fr" });
        }
      }

      if (tabRefRows.length >= 1) {
        if (tabPatterns.enRoot.length > 0) tabPatterns.patternValidated.en = true;
        if (tabPatterns.frRoot.length > 0) tabPatterns.patternValidated.fr = true;
        log(`  Trusting patterns from ${tabRefRows.length} reference rows (EN=${tabPatterns.patternValidated.en}, FR=${tabPatterns.patternValidated.fr})`);
      } else {
        log(`  Validating patterns with ${sampleUrls.length} sample URLs...`);
        await validatePatterns(tabPatterns, sampleUrls);
        log(`  Pattern validation result: EN=${tabPatterns.patternValidated.en}, FR=${tabPatterns.patternValidated.fr}`);
      }

      const matchResults = batchConstructUrls(
        needsMatching.map((r) => ({
          sourceUrl: r.sourceUrl,
          needsEn: r.needsEn,
          needsFr: r.needsFr,
          index: r.rowIndex,
        })),
        tabPatterns
      );

      const urlsToVerify: string[] = [];
      for (const [, match] of matchResults) {
        if (match.enUrl) urlsToVerify.push(match.enUrl);
        if (match.frUrl) urlsToVerify.push(match.frUrl);
      }

      if (urlsToVerify.length > 0) {
        log(`  Verifying ${urlsToVerify.length} constructed URLs with HEAD checks...`);
        const existence = await batchHeadCheck(urlsToVerify);
        let verified = 0;
        for (const [, match] of matchResults) {
          if (match.enUrl && !existence.get(match.enUrl)) {
            match.enUrl = null;
            match.confidenceEn = null;
            match.matchMethodEn = null;
          } else if (match.enUrl) {
            verified++;
          }
          if (match.frUrl && !existence.get(match.frUrl)) {
            match.frUrl = null;
            match.confidenceFr = null;
            match.matchMethodFr = null;
          } else if (match.frUrl) {
            verified++;
          }
        }
        log(`  Verified: ${verified}/${urlsToVerify.length} URLs exist`);
      }

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
