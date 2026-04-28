import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import ExcelJS from "exceljs";
import type { XlsBook } from "node-xlrd";
import xlrd from "node-xlrd";
import path from "path";
import fs from "fs";
import { storage } from "./storage";
import {
  learnTabPatterns,
  mergeIntoTabPatterns,
  summarizeSegmentTranslations,
  batchConstructUrls,
  constructTargetUrl,
  constructAllTargetUrls,
  validatePatterns,
  batchHeadCheck,
  crawlDirectory,
  matchAgainstInventory,
  titleMatchUnmatched,
  aiMatchUnmatched,
  batchTranslate,
  clearCaches,
  clearAllCaches,
  validateDepthMatch,
  emptyBatchResult,
  getResultUrl,
  getResultConf,
  getResultMethod,
  getResultFlags,
  setResultMatch,
  clearResultMatch,
  type MatchFlags,
  langRoot,
  langSrcRoot,
  langCrawlScope,
  type TargetLang,
  type TabPatterns,
  type CrawlInventory,
  type BatchMatchResult,
  mergeInventories,
  verifySeedUrls,
  detectCrossScriptLangs,
  harvestAlternateLinks,
  type AlternateLinkCache,
  mineSegmentsFromInventory,
  computeSiblingScope,
  isUrlUnderTgtDir,
  filterInventoryToScope,
  type MatchTrace,
  type RowLangTrace,
  setTrace,
} from "./scraper";
import { log } from "./index";

function xlsToWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  return new Promise((resolve, reject) => {
    xlrd.open(filePath, (err: Error | null, bk: XlsBook) => {
      if (err) return reject(err);
      try {
        const wb = new ExcelJS.Workbook();
        const sheetCount: number = bk.sheet.count;
        for (let si = 0; si < sheetCount; si++) {
          const xlSheet = bk.sheet.byIndex(si);
          const ws = wb.addWorksheet(xlSheet.name);
          for (let r = 0; r < xlSheet.nrows; r++) {
            const vals: unknown[] = xlSheet.row.getValues(r);
            const wsRow = ws.getRow(r + 1);
            for (let c = 0; c < vals.length; c++) {
              const v = vals[c];
              wsRow.getCell(c + 1).value = (v === null || v === undefined) ? null : (v as ExcelJS.CellValue);
            }
            wsRow.commit();
          }
        }
        resolve(wb);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function readWorkbook(filePath: string, originalName?: string): Promise<ExcelJS.Workbook> {
  const ext = path.extname(originalName ?? filePath).toLowerCase();
  if (ext === ".xls") {
    return xlsToWorkbook(filePath);
  }
  const wb = new ExcelJS.Workbook();
  if (ext === ".csv") {
    await wb.csv.readFile(filePath);
  } else {
    await wb.xlsx.readFile(filePath);
  }
  return wb;
}

const SEEDS_SHEET_NAMES = new Set(["seeds", "seed"]);
function isSeedsSheet(name: string): boolean {
  return SEEDS_SHEET_NAMES.has(name.trim().toLowerCase());
}

const EXCLUDES_SHEET_NAMES = new Set(["excludes", "exclude", "exclusions"]);
function isExcludesSheet(name: string): boolean {
  return EXCLUDES_SHEET_NAMES.has(name.trim().toLowerCase());
}
function isMetadataSheet(name: string): boolean {
  return isSeedsSheet(name) || isExcludesSheet(name);
}

// Excludes sheet payload: tab name → per-language list of HE source path
// prefixes. A row whose source URL pathname starts with any prefix in the
// per-tab list for a given language is marked excluded for that language
// (method="excluded-config") and skipped from the matching pipeline.
export type ExcludesMap = Map<string, Partial<Record<TargetLang, string[]>>>;

function normalizeExcludePath(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  let p: string;
  if (/^https?:\/\//i.test(v)) {
    try { p = new URL(v).pathname; } catch { return null; }
  } else {
    p = v.startsWith("/") ? v : "/" + v;
  }
  return p.toLowerCase();
}

function splitExcludeCell(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n;,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parseExcludesSheet(ws: ExcelJS.Worksheet, knownSheets: string[]): ExcludesMap {
  const result: ExcludesMap = new Map();
  const data = worksheetToAoa(ws);
  if (data.length === 0) return result;
  const headerRowCells = data[0].map(c => (c || "").toString().trim().toLowerCase());

  let tabCol = 0;
  const langCol: Partial<Record<TargetLang, number>> = {};
  let headerDetected = false;
  for (let i = 0; i < headerRowCells.length; i++) {
    const h = headerRowCells[i];
    if (h === "tab" || h === "sheet" || h === "name" || h === "tab name" || h === "sheet name") { tabCol = i; headerDetected = true; }
    else if (h === "en" || h === "english") { langCol.en = i; headerDetected = true; }
    else if (h === "fr" || h === "french") { langCol.fr = i; headerDetected = true; }
    else if (h === "ru" || h === "russian") { langCol.ru = i; headerDetected = true; }
    else if (h === "ar" || h === "arabic") { langCol.ar = i; headerDetected = true; }
  }
  if (!headerDetected) {
    langCol.en = 1; langCol.fr = 2; langCol.ru = 3; langCol.ar = 4;
  }
  const startRow = headerDetected ? 1 : 0;
  if (data.length <= startRow) return result;

  const knownLower = new Map<string, string>();
  for (const s of knownSheets) knownLower.set(s.toLowerCase(), s);

  for (let r = startRow; r < data.length; r++) {
    const row = data[r];
    const tabRaw = (row[tabCol] || "").toString().trim();
    if (!tabRaw) continue;
    const matched = knownLower.get(tabRaw.toLowerCase());
    if (!matched) {
      log(`Excludes sheet: tab "${tabRaw}" (row ${r + 1}) does not match any data sheet — ignoring`);
      continue;
    }
    const entry: Partial<Record<TargetLang, string[]>> = result.get(matched) ?? {};
    for (const l of ["en", "fr", "ru", "ar"] as TargetLang[]) {
      const ci = langCol[l];
      if (ci === undefined) continue;
      const cell = (row[ci] || "").toString();
      const prefixes = splitExcludeCell(cell)
        .map(normalizeExcludePath)
        .filter((p): p is string => !!p);
      if (prefixes.length === 0) continue;
      const list = entry[l] ?? [];
      for (const p of prefixes) if (!list.includes(p)) list.push(p);
      entry[l] = list;
    }
    if (Object.keys(entry).length > 0) result.set(matched, entry);
  }
  return result;
}

export type SeedMap = Map<string, Partial<Record<TargetLang, string>>>;

function normalizeSeedToPath(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  let p: string;
  if (/^https?:\/\//i.test(v)) {
    try { p = new URL(v).pathname; } catch { return null; }
  } else {
    p = v.startsWith("/") ? v : "/" + v;
  }
  if (!p.endsWith("/")) {
    const last = p.split("/").pop() || "";
    if (!/\.[a-z0-9]{2,5}$/i.test(last)) p += "/";
  }
  return p;
}

function parseSeedsSheet(ws: ExcelJS.Worksheet, knownSheets: string[]): SeedMap {
  const result: SeedMap = new Map();
  const data = worksheetToAoa(ws);
  if (data.length === 0) return result;
  const headerRowCells = data[0].map(c => (c || "").toString().trim().toLowerCase());

  let tabCol = 0;
  const langCol: Partial<Record<TargetLang, number>> = {};
  let headerDetected = false;
  for (let i = 0; i < headerRowCells.length; i++) {
    const h = headerRowCells[i];
    if (h === "tab" || h === "sheet" || h === "name" || h === "tab name" || h === "sheet name") { tabCol = i; headerDetected = true; }
    else if (h === "en" || h === "english") { langCol.en = i; headerDetected = true; }
    else if (h === "fr" || h === "french") { langCol.fr = i; headerDetected = true; }
    else if (h === "ru" || h === "russian") { langCol.ru = i; headerDetected = true; }
    else if (h === "ar" || h === "arabic") { langCol.ar = i; headerDetected = true; }
  }
  if (!headerDetected) {
    langCol.en = 1; langCol.fr = 2; langCol.ru = 3; langCol.ar = 4;
  }
  const startRow = headerDetected ? 1 : 0;
  if (data.length <= startRow) return result;

  const knownLower = new Map<string, string>();
  for (const s of knownSheets) knownLower.set(s.toLowerCase(), s);

  for (let r = startRow; r < data.length; r++) {
    const row = data[r];
    const tabRaw = (row[tabCol] || "").toString().trim();
    if (!tabRaw) continue;
    const matched = knownLower.get(tabRaw.toLowerCase());
    if (!matched) {
      log(`Seeds sheet: tab "${tabRaw}" (row ${r + 1}) does not match any data sheet — ignoring`);
      continue;
    }
    const entry: Partial<Record<TargetLang, string>> = {};
    for (const l of ["en", "fr", "ru", "ar"] as TargetLang[]) {
      const ci = langCol[l];
      if (ci === undefined) continue;
      const cell = (row[ci] || "").toString();
      const seg = normalizeSeedToPath(cell);
      if (seg) entry[l] = seg;
    }
    if (Object.keys(entry).length > 0) result.set(matched, entry);
  }
  return result;
}

function pathToSegments(p: string): string[] {
  const segs = p.split("/").filter(Boolean);
  while (segs.length > 0) {
    const last = segs[segs.length - 1];
    if (/\.[a-z0-9]{2,5}$/i.test(last)) { segs.pop(); continue; }
    if (last.toLowerCase() === "pages" || last.toLowerCase() === "forms") { segs.pop(); continue; }
    break;
  }
  return segs;
}

function findJobFile(jobId: string): string | null {
  for (const ext of [".xlsx", ".xls", ".csv"]) {
    const p = `/tmp/uploads/${jobId}${ext}`;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls", ".csv"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel (.xlsx, .xls) and CSV files are allowed"));
    }
  },
});

interface JobControl {
  cancel: boolean;
  abortController: AbortController;
  signal: AbortSignal;
}
const activeJobs = new Map<string, JobControl>();
function newJobControl(): JobControl {
  const ac = new AbortController();
  return { cancel: false, abortController: ac, signal: ac.signal };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/upload", upload.single("file"), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const workbook = await readWorkbook(req.file.path, req.file.originalname);
      let totalUrls = 0;

      for (const worksheet of workbook.worksheets) {
        if (isMetadataSheet(worksheet.name)) continue;
        totalUrls += Math.max(0, worksheet.rowCount - 1);
      }

      const langStr = typeof req.body?.languages === "string" ? req.body.languages : "";
      const targetLangs = langStr ? langStr.split(",") : ["en", "fr", "ru", "ar"];

      const rawCap = req.body?.crawlPageCap;
      let crawlPageCap = 0;
      if (rawCap !== undefined && rawCap !== null && rawCap !== "" && rawCap !== "auto") {
        const n = parseInt(String(rawCap), 10);
        if (Number.isFinite(n) && n > 0) crawlPageCap = Math.min(n, 10000);
      }

      const job = await storage.createJob({
        fileName: req.file.originalname,
        status: "pending",
        totalUrls,
        processedUrls: 0,
        matchedUrls: 0,
        targetLanguages: targetLangs,
        crawlPageCap,
        currentStep: "idle",
      });

      if (!fs.existsSync("/tmp/uploads")) {
        fs.mkdirSync("/tmp/uploads", { recursive: true });
      }
      const origExt = path.extname(req.file.originalname).toLowerCase();
      const savedExt = [".xls", ".csv"].includes(origExt) ? origExt : ".xlsx";
      const savedPath = `/tmp/uploads/${job.id}${savedExt}`;
      fs.copyFileSync(req.file.path, savedPath);
      fs.unlinkSync(req.file.path);

      res.json({ jobId: job.id, totalUrls, sheets: workbook.worksheets.filter(ws => !isMetadataSheet(ws.name)).map(ws => ws.name) });
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

      // Single-tenant safeguard: matchers share global in-process caches
      // (translation cache, alternate-link cache, inventory caches) reset by
      // clearAllCaches() at the start of each processJob. Two concurrent
      // jobs would corrupt those caches mid-run.
      //
      // We previously *auto-cancelled* any other running job, but that lets
      // one user destroy another user's in-flight job (cross-user
      // interference). Instead we now refuse to start when another job is
      // active and surface a 409 so the second user is told explicitly that
      // someone else's job must finish (or be stopped via that user's Stop
      // button). The `?force=1` query flag preserves the legacy "cancel
      // others and start anyway" behaviour for the operator who knows they
      // own both jobs. See replit.md "Job concurrency" for full rationale.
      const force = String(req.query.force ?? "").toLowerCase() === "1" ||
                    String(req.body?.force ?? "").toLowerCase() === "true";
      const otherActive = Array.from(activeJobs.entries()).filter(([id]) => id !== jobId);
      if (otherActive.length > 0 && !force) {
        const otherIds = otherActive.map(([id]) => id).join(", ");
        log(`Refusing to start ${jobId}: another job is still running (${otherIds}). Pass ?force=1 to override.`);
        return res.status(409).json({
          message: "Another mapping job is already running. Wait for it to finish or stop it from its own browser tab. Use ?force=1 to override.",
          activeJobIds: otherActive.map(([id]) => id),
        });
      }
      for (const [existingJobId, existingControl] of otherActive) {
        log(`force=1: cancelling previous job ${existingJobId} before starting ${jobId}`);
        existingControl.cancel = true;
        existingControl.abortController.abort();
        await storage.updateJob(existingJobId, { status: "cancelled", currentStep: "done" });
        activeJobs.delete(existingJobId);
      }

      const control = newJobControl();
      activeJobs.set(jobId, control);

      await storage.updateJob(jobId, { status: "processing", currentStep: "learning" });

      res.json({ message: "Processing started" });

      // try/finally guarantees activeJobs is cleared even if processJob throws
      // before reaching its own activeJobs.delete() at the end of the success
      // path. Without this, a thrown error would leave a stale entry that
      // forces the next job-start to issue a spurious cancel log.
      (async () => {
        try {
          await processJob(jobId, threshold, control);
        } catch (err: any) {
          log(`Job processing error: ${err.message}`);
          await storage.updateJob(jobId, { status: "error", currentStep: err.message }).catch(() => {});
        } finally {
          if (activeJobs.get(jobId) === control) {
            activeJobs.delete(jobId);
          }
        }
      })();
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/jobs/:id/stop", async (req: Request, res: Response) => {
    try {
      const jobId = req.params.id as string;
      const job = await storage.getJob(jobId);
      if (!job) return res.status(404).json({ message: "Job not found" });

      const control = activeJobs.get(jobId);
      if (control) {
        control.cancel = true;
        control.abortController.abort();
        await storage.updateJob(jobId, { currentStep: "stopping" });
        log(`Job ${jobId} stop requested by user (abort signaled, awaiting partial save)`);
      } else if (job.status === "processing" || job.status === "pending") {
        await storage.updateJob(jobId, { status: "cancelled", currentStep: "done" });
        log(`Job ${jobId} marked cancelled (no active control found)`);
      }
      res.json({ message: "Job stop requested" });
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
      // Optional `?since=<count>` cursor for delta polling. The storage
      // layer orders rows by (sheet_name, row_index) so OFFSET is stable
      // across calls. Default (no cursor) preserves the original full
      // response, so existing callers (results-view single-fetch, the
      // download endpoint) keep working byte-identically.
      const sinceRaw = (req.query.since as string | undefined) ?? undefined;
      let sinceCount: number | undefined;
      if (sinceRaw !== undefined) {
        const n = parseInt(sinceRaw, 10);
        if (Number.isFinite(n) && n >= 0) sinceCount = n;
      }
      const results = await storage.getResultsByJob(req.params.id as string, sinceCount);
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

      const filePath = findJobFile(jobId);
      if (!filePath) {
        return res.status(404).json({ message: "Source file not found" });
      }

      const workbook = await readWorkbook(filePath);
      const results = await storage.getResultsByJob(jobId);

      const resultMap = new Map<string, Map<number, typeof results[0]>>();
      for (const r of results) {
        if (!resultMap.has(r.sheetName)) {
          resultMap.set(r.sheetName, new Map());
        }
        resultMap.get(r.sheetName)!.set(r.rowIndex, r);
      }

      for (const worksheet of workbook.worksheets) {
        const sheetName = worksheet.name;
        const sheetResults = resultMap.get(sheetName);
        if (!sheetResults) continue;

        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;
          const result = sheetResults.get(rowNumber - 1);
          if (!result) return;

          if (result.englishUrl && !row.getCell(3).value) {
            row.getCell(3).value = result.englishUrl;
          }
          if (result.frenchUrl && !row.getCell(4).value) {
            row.getCell(4).value = result.frenchUrl;
          }
          if (result.russianUrl && !row.getCell(5).value) {
            row.getCell(5).value = result.russianUrl;
          }
          if (result.arabicUrl && !row.getCell(6).value) {
            row.getCell(6).value = result.arabicUrl;
          }
        });
      }

      // Stream the workbook directly into the HTTP response — no /tmp
      // round-trip. Saves a full disk write+read+delete per download and
      // lets large files start streaming to the client immediately.
      const outputName = job.fileName.replace(/\.xlsx?$/i, "_mapped.xlsx");
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(outputName)}"`
      );
      try {
        await workbook.xlsx.write(res);
        res.end();
      } finally {
        // The source upload was previously cleaned up after `res.download`'s
        // callback fired; preserve that behavior so re-runs don't pile up
        // /tmp/uploads files. Best-effort: never throw out of the handler.
        try { fs.unlinkSync(filePath); } catch {}
      }
    } catch (error: any) {
      log(`Download error: ${error.message}`);
      // If headers already flushed (mid-stream), we can't send a JSON error.
      if (!res.headersSent) {
        res.status(500).json({ message: error.message });
      } else {
        try { res.end(); } catch {}
      }
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
  existingRu: string;
  existingAr: string;
  originalEn: string;
  originalFr: string;
  originalRu: string;
  originalAr: string;
  needsEn: boolean;
  needsFr: boolean;
  needsRu: boolean;
  needsAr: boolean;
}

type TabRefRow = { sourceUrl: string; enUrl?: string; frUrl?: string; ruUrl?: string; arUrl?: string };

interface TabData {
  sheetName: string;
  allRows: RowData[];
  tabRefRows: TabRefRow[];
  data: any[][];
  // Per-row, per-language exclusion records. Populated from the optional
  // Excludes workbook sheet (method="excluded-config") and from the
  // HE-only auto-detect pass (method="excluded-auto"). The save block
  // writes the method into the existing-URL cell prefixed with a marker
  // (or leaves the cell blank — see save block) so the user can audit.
  excludedMethods?: Map<number, Map<TargetLang, string>>;
}

function cellValueToString(v: ExcelJS.CellValue): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v instanceof Date) return v;
  if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map(r => r.text).join("");
  if ("text" in v) return (v as ExcelJS.CellHyperlinkValue).text;
  if ("result" in v) {
    const res = (v as ExcelJS.CellFormulaValue).result;
    return (res !== undefined && res !== null) ? cellValueToString(res as ExcelJS.CellValue) : null;
  }
  if ("error" in v) return String((v as ExcelJS.CellErrorValue).error);
  return null;
}

function worksheetToAoa(ws: ExcelJS.Worksheet): any[][] {
  const data: any[][] = [];
  const rowCount = ws.rowCount;
  for (let r = 1; r <= rowCount; r++) {
    const arr: any[] = [];
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      arr[colNum - 1] = cellValueToString(cell.value) ?? "";
    });
    data.push(arr);
  }
  return data;
}

function parseSheet(
  sheetName: string,
  ws: ExcelJS.Worksheet,
  targetLangs: string[]
): TabData | null {
  const data = worksheetToAoa(ws);
  if (data.length < 2) return null;

  const tabRefRows: TabData["tabRefRows"] = [];
  const allRows: RowData[] = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const title = (row[0] || "").toString().trim();
    const rawSource = (row[1] || "").toString().trim();
    const existingEn = (row[2] || "").toString().trim();
    const existingFr = (row[3] || "").toString().trim();
    const existingRu = (row[4] || "").toString().trim();
    const existingAr = (row[5] || "").toString().trim();

    let sourceUrl = rawSource;
    if (!sourceUrl.startsWith("http") && sourceUrl.includes("|")) {
      const afterPipe = sourceUrl.split("|").pop()?.trim() || "";
      if (afterPipe.startsWith("http")) sourceUrl = afterPipe;
    }

    if (!sourceUrl || !sourceUrl.startsWith("http")) continue;

    if (existingEn || existingFr || existingRu || existingAr) {
      tabRefRows.push({
        sourceUrl,
        enUrl: existingEn || undefined,
        frUrl: existingFr || undefined,
        ruUrl: existingRu || undefined,
        arUrl: existingAr || undefined,
      });
    }

    const needsEn = targetLangs.includes("en") && !existingEn;
    const needsFr = targetLangs.includes("fr") && !existingFr;
    const needsRu = targetLangs.includes("ru") && !existingRu;
    const needsAr = targetLangs.includes("ar") && !existingAr;

    allRows.push({
      rowIndex: i, title, sourceUrl,
      existingEn, existingFr, existingRu, existingAr,
      originalEn: existingEn, originalFr: existingFr, originalRu: existingRu, originalAr: existingAr,
      needsEn, needsFr, needsRu, needsAr,
    });
  }

  return { sheetName, allRows, tabRefRows, data };
}

async function matchTab(
  tabData: TabData,
  crawlCache: Map<string, CrawlInventory>,
  control: JobControl,
  targetLangs: TargetLang[],
  crawlPageCap: number,
  seedOverrides?: Partial<Record<TargetLang, string>>,
  alternateLinkCache?: AlternateLinkCache,
  globalPatterns?: TabPatterns,
  feedbackAnchors?: Partial<Record<TargetLang, string[]>>,
): Promise<{
  matchResults: Map<number, BatchMatchResult>;
  inventories: Record<TargetLang, CrawlInventory | null>;
  tabPatterns: TabPatterns;
  usedUrls: Record<TargetLang, Set<string>>;
  newFeedbackAnchors: Record<TargetLang, string[]>;
  minedSegments: Record<TargetLang, Map<string, string>>;
  coverageStats: Record<TargetLang, { totalInventory: number; mappedSubtrees: number; sparseBefore: number; sparseAfter: number; backfilledUrls: number }>;
  fenceStats: Record<TargetLang, { titleRejected: number; aiRejected: number; markedRowIndices: Set<number>; nonFenceFailureRowIndices: Set<number> }>;
  // Task #74: per-lang count of title-stage commits admitted under the
  // scope-active relaxed floors that the pre-loosening cascade would have
  // rejected. Accumulated across all title-stage calls inside this tab.
  titleLoosenedAccepted: Record<TargetLang, number>;
  // Task #84: per-row "why" trace accumulated across the title-stage calls in
  // this tab. The AI stage runs outside matchTab and writes into the same
  // map (passed by reference from processJob).
  matchTrace: MatchTrace;
}> {
  const { sheetName, allRows, tabRefRows } = tabData;
  const allLangsLocal: TargetLang[] = ["en", "fr", "ru", "ar"];
  const langs: TargetLang[] = allLangsLocal.filter(l => targetLangs.includes(l));
  const langLabels: Record<TargetLang, string> = { en: "EN", fr: "FR", ru: "RU", ar: "AR" };
  const refUrlKey: Record<TargetLang, "enUrl" | "frUrl" | "ruUrl" | "arUrl"> = { en: "enUrl", fr: "frUrl", ru: "ruUrl", ar: "arUrl" };

  // Sibling-scope title-fence rejection counter (Task #70). Declared at the
  // top of matchTab so the pattern+crawl and HEAD commit paths (which run
  // before the title-match stage) can both increment it; aggregated into the
  // returned fenceStats. The AI-stage fence is tracked outside matchTab.
  const titleFenceRejected: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };

  // Task #84: per-row "why" trace for this tab. Title-stage calls below pass
  // this in; the AI stage (in processJob) appends to the same map by ref.
  const matchTrace: MatchTrace = new Map();
  // Task #74: per-lang count of title-stage matches admitted under the
  // relaxed (scope-active) floors that the pre-loosening cascade would have
  // rejected. Accumulated across the title-stage call and projected into
  // matchTab's return so processJob can emit per-tab telemetry.
  const titleLoosenedAccepted: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  // Per-row marks for the sibling fence (Task #70 row-level telemetry):
  // remember which rowIndices had at least one candidate rejected by the
  // fence in this tab × language. processJob diffs these against the final
  // committed results to compute "rows blocked by fence only".
  const titleFenceMarks: Record<TargetLang, Set<number>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };
  // Companion set: rowIndices for which the title-stage commit paths
  // (pattern+crawl, alt-link, HEAD) failed for a NON-fence reason. The
  // strict "fence rejected the only candidate" metric is computed as
  // titleFenceMarks ∖ titleNonFenceFailureMarks restricted to rows whose
  // final committed result has no URL for that language. Tracking both
  // sides avoids the proxy/upper-bound concern: if a row is in
  // nonFenceFailureMarks, some other failure also contributed and the
  // fence cannot have been the sole cause.
  const titleNonFenceFailureMarks: Record<TargetLang, Set<number>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };

  const tabPatterns = learnTabPatterns(tabRefRows, langs);
  // Tabs whose source slugs are in a different script/vocabulary from the
  // target inventory slugs (e.g. EN sources `/benefits/Disability` vs RU
  // inventory `/Benefits_ru/Nehut_ru/`) make the title-match "no shared
  // segments → reject" rail a false-positive generator. Detect once per tab
  // from reference rows and disable the rail per-lang downstream.
  // Declared early so pattern+crawl/alt-link/HEAD commits can stamp the
  // crossScript flag onto BatchMatchResult before downstream merges.
  const crossScriptLangs = detectCrossScriptLangs(tabRefRows, langs);
  const preMergeSegCounts: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  const preMergePairCounts: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  for (const l of langs) {
    preMergeSegCounts[l] = tabPatterns.segmentMap.get(l)?.size || 0;
    preMergePairCounts[l] = tabPatterns.rootMappings.get(l)?.length || 0;
  }
  if (globalPatterns) {
    const { addedSegments, addedPairs } = mergeIntoTabPatterns(tabPatterns, globalPatterns, langs);
    const attribution = langs.map(l => {
      const totalSeg = tabPatterns.segmentMap.get(l)?.size || 0;
      const totalPairs = tabPatterns.rootMappings.get(l)?.length || 0;
      return `${l.toUpperCase()} segments=${preMergeSegCounts[l]} per-tab + ${addedSegments[l]} from global = ${totalSeg}; root maps=${preMergePairCounts[l]} per-tab + ${addedPairs[l]} from global = ${totalPairs}`;
    });
    log(`Tab "${sheetName}": pattern source attribution after global merge:`);
    for (const line of attribution) log(`  ${line}`);
  }
  log(`Tab "${sheetName}": ${tabRefRows.length} reference rows, ${allRows.length} total rows (active langs: ${langs.map(l => l.toUpperCase()).join(",") || "none"})`);

  const needsMatching = allRows.filter((r) => r.needsEn || r.needsFr || r.needsRu || r.needsAr);
  const matchResults = new Map<number, BatchMatchResult>();
  const inventories: Record<TargetLang, CrawlInventory | null> = { en: null, fr: null, ru: null, ar: null };
  const usedUrls: Record<TargetLang, Set<string>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };

  const userSeedSegs: Partial<Record<TargetLang, string[]>> = {};
  if (seedOverrides) {
    for (const l of langs) {
      const p = seedOverrides[l];
      if (p) {
        const segs = pathToSegments(p);
        if (segs.length > 0) userSeedSegs[l] = segs;
      }
    }
  }

  const hasAnyRoot = langs.some(l => {
    if (userSeedSegs[l]) return true;
    if (langRoot(tabPatterns, l).length > 0) return true;
    const pp = tabPatterns.rootMappings.get(l) || [];
    if (pp.some(m => m.targetRoot.length > 0)) return true;
    if (tabPatterns.langSuffixRule[l]) return true;
    return false;
  });
  if (needsMatching.length === 0 || !hasAnyRoot) {
    return {
      matchResults, inventories, tabPatterns, usedUrls, matchTrace,
      newFeedbackAnchors: { en: [], fr: [], ru: [], ar: [] },
      minedSegments: { en: new Map(), fr: new Map(), ru: new Map(), ar: new Map() },
      coverageStats: {
        en: { totalInventory: 0, mappedSubtrees: 0, sparseBefore: 0, sparseAfter: 0, backfilledUrls: 0 },
        fr: { totalInventory: 0, mappedSubtrees: 0, sparseBefore: 0, sparseAfter: 0, backfilledUrls: 0 },
        ru: { totalInventory: 0, mappedSubtrees: 0, sparseBefore: 0, sparseAfter: 0, backfilledUrls: 0 },
        ar: { totalInventory: 0, mappedSubtrees: 0, sparseBefore: 0, sparseAfter: 0, backfilledUrls: 0 },
      },
      fenceStats: {
        en: { titleRejected: 0, aiRejected: 0, markedRowIndices: new Set(), nonFenceFailureRowIndices: new Set() },
        fr: { titleRejected: 0, aiRejected: 0, markedRowIndices: new Set(), nonFenceFailureRowIndices: new Set() },
        ru: { titleRejected: 0, aiRejected: 0, markedRowIndices: new Set(), nonFenceFailureRowIndices: new Set() },
        ar: { titleRejected: 0, aiRejected: 0, markedRowIndices: new Set(), nonFenceFailureRowIndices: new Set() },
      },
      titleLoosenedAccepted: { en: 0, fr: 0, ru: 0, ar: 0 },
    };
  }

  for (const l of langs) {
    if (langRoot(tabPatterns, l).length > 0 || userSeedSegs[l]) tabPatterns.patternValidated[l] = true;
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

  const seedUrls: Record<TargetLang, string[]> = { en: [], fr: [], ru: [], ar: [] };
  for (const ref of tabRefRows) {
    for (const l of langs) {
      const url = ref[refUrlKey[l]];
      if (url) {
        try {
          const parsed = new URL(url);
          const pathSegs = parsed.pathname.split("/").filter(Boolean);
          const parentPath = pathSegs.slice(0, -1);
          const parentUrl = parsed.origin + "/" + parentPath.join("/") + "/";
          seedUrls[l].push(url);
          seedUrls[l].push(parentUrl);
          const pagesIdx = parentPath.findIndex(s => s.toLowerCase() === "pages");
          if (pagesIdx >= 0) {
            const sectionPath = parentPath.slice(0, pagesIdx);
            const sectionPagesDir = parsed.origin + "/" + sectionPath.join("/") + "/Pages/";
            seedUrls[l].push(sectionPagesDir);
            seedUrls[l].push(sectionPagesDir + "default.aspx");
            seedUrls[l].push(sectionPagesDir + "Forms/AllItems.aspx");
          } else {
            seedUrls[l].push(parsed.origin + "/" + parentPath.join("/") + "/Pages/default.aspx");
          }
        } catch {}
      }
    }
  }

  const needsKey: Record<TargetLang, keyof RowData> = { en: "needsEn", fr: "needsFr", ru: "needsRu", ar: "needsAr" };
  for (const l of langs) {
    const uniqueSeedCount = new Set(seedUrls[l]).size;
    log(`  ${langLabels[l]} reference seeds: ${uniqueSeedCount} unique URLs from ${tabRefRows.length} reference rows`);
  }

  function normalizeAnchorRoot(anchor: string[]): string[] {
    let s = anchor.slice();
    while (s.length > 0) {
      const last = s[s.length - 1];
      if (/\.[a-z0-9]{2,5}$/i.test(last)) { s.pop(); continue; }
      if (last.toLowerCase() === "pages" || last.toLowerCase() === "forms") { s.pop(); continue; }
      break;
    }
    return s;
  }

  // ---- FEEDBACK ANCHORS FROM PRIOR PASSES ----
  // When the coverage diagnostic in an earlier pass logged a "missing subtree"
  // (e.g. /Odot_ru/sheelotTshuvot/), seed crawl this pass with that subtree's
  // root and its `…/Pages/default.aspx` so the crawler reaches that subtree.
  // Survivors of the HEAD probe become anchors with their own crawl scope.
  const FEEDBACK_PROBE_CAP = 2000;
  const feedbackProbePromises: Promise<void>[] = [];
  const feedbackAliveByLang: Record<TargetLang, Set<string>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };
  if (origin && feedbackAnchors) {
    for (const l of langs) {
      const paths = feedbackAnchors[l] || [];
      if (paths.length === 0) continue;
      const probes: string[] = [];
      const seen = new Set<string>();
      for (const p of paths) {
        if (probes.length >= FEEDBACK_PROBE_CAP) break;
        const norm = "/" + p.replace(/^\/+|\/+$/g, "");
        if (!norm || norm === "/") continue;
        const u1 = origin + norm + "/";
        const u2 = origin + norm + "/Pages/default.aspx";
        for (const u of [u1, u2]) {
          if (!seen.has(u)) { seen.add(u); probes.push(u); }
          if (probes.length >= FEEDBACK_PROBE_CAP) break;
        }
      }
      if (probes.length === 0) continue;
      log(`  ${langLabels[l]} feedback anchors from prior pass: HEAD-probing ${probes.length} URL(s) (${paths.length} subtree path(s))...`);
      feedbackProbePromises.push(
        batchHeadCheck(probes, control.signal).then(results => {
          let alive = 0;
          const adoptedPaths: string[] = [];
          const seenAdopted = new Set<string>();
          for (const [u, r] of Array.from(results.entries())) {
            if (r.ok) {
              seedUrls[l].push(u);
              feedbackAliveByLang[l].add(u);
              alive++;
              try {
                const p = new URL(u).pathname.replace(/\/Pages\/default\.aspx$/i, "/").replace(/\/+$/, "/");
                if (!seenAdopted.has(p)) { seenAdopted.add(p); adoptedPaths.push(p); }
              } catch {}
            }
          }
          const top5 = adoptedPaths.slice(0, 5).join(", ");
          log(`  ${langLabels[l]} feedback anchors: ${alive}/${probes.length} alive (added to crawl seeds)${top5 ? ` — top: ${top5}` : ""}`);
        })
      );
    }
  }
  if (feedbackProbePromises.length > 0) await Promise.all(feedbackProbePromises);

  // Surviving feedback URLs need their section root added to anchorRoots so
  // the crawl scope actually covers them — `crawlDirectory` drops seed URLs
  // whose pathname does not start with the active scopePrefix.
  const feedbackAnchorRoots: Record<TargetLang, string[][]> = { en: [], fr: [], ru: [], ar: [] };
  for (const l of langs) {
    if (feedbackAliveByLang[l].size === 0) continue;
    const seenAnchorKey = new Set<string>();
    for (const u of Array.from(feedbackAliveByLang[l])) {
      try {
        const parts = new URL(u).pathname.split("/").filter(Boolean);
        const section = normalizeAnchorRoot(parts);
        if (section.length === 0) continue;
        const key = section.map(s => s.toLowerCase()).join("/");
        if (seenAnchorKey.has(key)) continue;
        seenAnchorKey.add(key);
        feedbackAnchorRoots[l].push(section);
      } catch {}
    }
    if (feedbackAnchorRoots[l].length > 0) {
      log(`  ${langLabels[l]} feedback anchors expanded crawl scope with ${feedbackAnchorRoots[l].length} new section root(s)`);
    }
  }

  // ---- PRE-CRAWL SEED DISCOVERY ----
  // Pass 1: For every source URL the workbook references, construct the
  // predicted target URLs (the same "8 candidates per source" the AI step
  // uses), HEAD-probe them concurrently, and feed surviving (200 OK) URLs
  // into the crawl seed list. This guarantees the AI sees pages that the
  // auto-inferred anchor scope would otherwise have missed entirely (e.g. RU
  // FAQ subtree).
  // Pass 2 (HE sibling expansion): When pass 1 finds a `…/Pages/default.aspx`
  // URL alive in the target language, invert the rootMapping to derive the
  // corresponding HE section, gather every HE source row in that section
  // from the workbook, construct each one's target URL by prefix
  // substitution, and probe those too. This catches HE-side siblings whose
  // own row's predicted candidates didn't survive (e.g. because the per-row
  // mapping was learned from a different root pair).
  const PROBE_CAP_PER_LANG = 1000;

  // Group HE source rows by section path (path up to but not including
  // `/Pages/`) for fast lookup during sibling expansion.
  const heSectionToRows = new Map<string, { slugTail: string[] }[]>();
  for (const row of allRows) {
    try {
      const p = new URL(row.sourceUrl);
      if (origin && p.origin !== origin) continue;
      const parts = p.pathname.split("/").filter(Boolean);
      const pagesIdx = parts.findIndex(s => s.toLowerCase() === "pages");
      if (pagesIdx < 1) continue;
      const sectionKey = parts.slice(0, pagesIdx).map(s => s.toLowerCase()).join("/");
      const slugTail = parts.slice(pagesIdx);
      if (!heSectionToRows.has(sectionKey)) heSectionToRows.set(sectionKey, []);
      heSectionToRows.get(sectionKey)!.push({ slugTail });
    } catch {}
  }

  const aliveByLang: Record<TargetLang, Set<string>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };

  const probePromises: Promise<void>[] = [];
  for (const l of langs) {
    if (langRoot(tabPatterns, l).length === 0 && !userSeedSegs[l]) continue;
    const candidateSet = new Set<string>();
    for (const row of allRows) {
      const cs = constructAllTargetUrls(row.sourceUrl, l, tabPatterns);
      for (const c of cs) {
        try {
          const p = new URL(c);
          if (origin && p.origin !== origin) continue;
        } catch { continue; }
        candidateSet.add(c);
        if (candidateSet.size >= PROBE_CAP_PER_LANG) break;
      }
      if (candidateSet.size >= PROBE_CAP_PER_LANG) break;
    }
    if (candidateSet.size === 0) continue;
    const candidates = Array.from(candidateSet);
    log(`  ${langLabels[l]} pre-crawl seed discovery: HEAD-probing ${candidates.length} predicted target URL(s)...`);
    probePromises.push(
      batchHeadCheck(candidates, control.signal).then(results => {
        let alive = 0;
        let aliveDefaults = 0;
        for (const [u, r] of Array.from(results.entries())) {
          if (r.ok) {
            seedUrls[l].push(u);
            aliveByLang[l].add(u);
            alive++;
            if (/\/Pages\/default\.aspx$/i.test(u)) aliveDefaults++;
          }
        }
        log(`  ${langLabels[l]} pre-crawl seed discovery: ${alive}/${candidates.length} alive (added to crawl seeds; ${aliveDefaults} section roots)`);
      })
    );
  }
  if (probePromises.length > 0) await Promise.all(probePromises);

  // Pass 2: sibling expansion from alive `…/Pages/default.aspx` URLs.
  for (const l of langs) {
    const pairMappings = tabPatterns.rootMappings.get(l) || [];
    if (pairMappings.length === 0) continue;
    const aliveDefaults: string[] = [];
    for (const u of Array.from(aliveByLang[l])) {
      if (/\/Pages\/default\.aspx$/i.test(u)) aliveDefaults.push(u);
    }
    if (aliveDefaults.length === 0) continue;

    const siblingCandidates = new Set<string>();
    let rootsExpanded = 0;
    let capped = false;
    outer: for (const u of aliveDefaults) {
      let parsed: URL;
      try { parsed = new URL(u); } catch { continue; }
      const parts = parsed.pathname.split("/").filter(Boolean);
      const pagesIdx = parts.findIndex(s => s.toLowerCase() === "pages");
      if (pagesIdx < 1) continue;
      const targetSectionParts = parts.slice(0, pagesIdx);
      const targetSectionLower = targetSectionParts.map(s => s.toLowerCase());

      for (const m of pairMappings) {
        if (m.targetRoot.length === 0 || m.targetRoot.length > targetSectionLower.length) continue;
        let prefixOk = true;
        for (let i = 0; i < m.targetRoot.length; i++) {
          if (m.targetRoot[i].toLowerCase() !== targetSectionLower[i]) { prefixOk = false; break; }
        }
        if (!prefixOk) continue;
        const tail = targetSectionParts.slice(m.targetRoot.length);
        const heSectionParts = [...m.sourceRoot, ...tail];
        const heSectionKey = heSectionParts.map(s => s.toLowerCase()).join("/");
        const heRows = heSectionToRows.get(heSectionKey);
        if (!heRows || heRows.length === 0) continue;
        rootsExpanded++;
        for (const r of heRows) {
          const sib = parsed.origin + "/" + [...targetSectionParts, ...r.slugTail].join("/");
          if (aliveByLang[l].has(sib) || siblingCandidates.has(sib)) continue;
          siblingCandidates.add(sib);
          if (siblingCandidates.size >= PROBE_CAP_PER_LANG) { capped = true; break outer; }
        }
      }
    }
    if (siblingCandidates.size === 0) continue;
    const sibList = Array.from(siblingCandidates);
    log(`  ${langLabels[l]} sibling expansion: ${aliveDefaults.length} alive section root(s), ${rootsExpanded} root→HE-section expansion(s) → probing ${sibList.length} HE-sibling candidate(s)${capped ? " (capped)" : ""}`);
    const sibResults = await batchHeadCheck(sibList, control.signal);
    let sibAlive = 0;
    for (const [u, r] of Array.from(sibResults.entries())) {
      if (r.ok) {
        seedUrls[l].push(u);
        aliveByLang[l].add(u);
        sibAlive++;
      }
    }
    log(`  ${langLabels[l]} sibling expansion: ${sibAlive}/${sibList.length} alive (added to crawl seeds)`);
  }

  const LANG_PAGE_CEILING = 50000;
  const crawlPromises: Promise<void>[] = [];
  const perLangInvs: Record<TargetLang, CrawlInventory[]> = { en: [], fr: [], ru: [], ar: [] };

  for (const l of langs) {
    const root = langRoot(tabPatterns, l);
    const perPair = tabPatterns.rootMappings.get(l) || [];
    const hasPerPairRoot = perPair.some(m => m.targetRoot.length > 0);
    const userSeed = userSeedSegs[l];
    if (!origin) continue;
    if (!userSeed && root.length === 0 && !hasPerPairRoot) continue;

    const anchorRoots: string[][] = [];
    const seenAnchors = new Set<string>();
    for (const m of perPair) {
      const norm = normalizeAnchorRoot(m.targetRoot);
      if (norm.length === 0) continue;
      const key = norm.map(s => s.toLowerCase()).join("/");
      if (seenAnchors.has(key)) continue;
      seenAnchors.add(key);
      anchorRoots.push(norm);
    }

    let crawlScopes: string[][];
    const combinedAnchors: string[][] = anchorRoots.slice();
    if (userSeed) {
      const userKey = userSeed.map(s => s.toLowerCase()).join("/");
      if (!combinedAnchors.some(a => a.map(s => s.toLowerCase()).join("/") === userKey)) {
        combinedAnchors.push(userSeed);
      }
    }
    for (const fbAnchor of feedbackAnchorRoots[l]) {
      const fbKey = fbAnchor.map(s => s.toLowerCase()).join("/");
      if (!combinedAnchors.some(a => a.map(s => s.toLowerCase()).join("/") === fbKey)) {
        combinedAnchors.push(fbAnchor);
      }
    }
    if (combinedAnchors.length > 0) {
      const sorted = combinedAnchors.slice().sort((a, b) => a.length - b.length);
      const kept: string[][] = [];
      for (const cand of sorted) {
        const candPath = cand.map(s => s.toLowerCase()).join("/");
        const isDescendant = kept.some(anc => {
          const ancPath = anc.map(s => s.toLowerCase()).join("/");
          return candPath === ancPath || candPath.startsWith(ancPath + "/");
        });
        if (!isDescendant) kept.push(cand);
      }
      const userPart = userSeed ? `user-seed /${userSeed.join("/")}/ + ` : "";
      log(`  ${langLabels[l]}: anchor source=${userPart}${anchorRoots.length} auto-inferred, coalesced to ${kept.length} top-level anchor(s)`);
      crawlScopes = kept;
    } else {
      let commonScope = langCrawlScope(tabPatterns, l);
      if (commonScope.length === 0 && root.length > 0) commonScope = root;
      if (commonScope.length === 0) continue;
      log(`  ${langLabels[l]}: anchor source=auto-inferred (fallback to common scope /${commonScope.join("/")}/)`);
      crawlScopes = [commonScope];
    }

    const perAnchorCap = Math.min(crawlPageCap, Math.max(1, Math.floor(LANG_PAGE_CEILING / crawlScopes.length)));
    log(`  ${langLabels[l]}: crawling ${crawlScopes.length} section anchor(s), cap=${perAnchorCap}/anchor (lang ceiling ${LANG_PAGE_CEILING})`);

    const allSeeds = Array.from(new Set(seedUrls[l]));

    for (const scope of crawlScopes) {
      const cacheKey = `${origin}|${l}:${scope.join("/")}`;
      const scopePath = "/" + scope.join("/");
      if (crawlCache.has(cacheKey)) {
        const inv = crawlCache.get(cacheKey)!;
        perLangInvs[l].push(inv);
        log(`    [${langLabels[l]}] anchor ${scopePath}/ cached: fetched=${inv.urls.size} titled=${inv.titleIndex.size}`);
        continue;
      }
      // Check if a broader parent scope was already crawled for this lang.
      // If so, filter it down to this scope rather than re-crawling. This
      // avoids redundant HTTP requests when different tabs share a common
      // target root but each infer a slightly narrower anchor.
      const scopeLower = (scopePath + "/").toLowerCase();
      let parentHit: CrawlInventory | null = null;
      for (const [key, cachedInv] of Array.from(crawlCache.entries())) {
        const pfx = `${origin}|${l}:`;
        if (!key.startsWith(pfx)) continue;
        const cachedScopeLower = ("/" + key.slice(pfx.length) + "/").toLowerCase();
        if (scopeLower.startsWith(cachedScopeLower) && cachedScopeLower.length < scopeLower.length) {
          parentHit = cachedInv;
          break;
        }
      }
      if (parentHit) {
        const sub = filterInventoryToScope(parentHit, scopePath);
        crawlCache.set(cacheKey, sub);
        perLangInvs[l].push(sub);
        log(`    [${langLabels[l]}] anchor ${scopePath}/ reused from parent crawl: ${sub.urls.size} URLs (${parentHit.urls.size} in parent)`);
        continue;
      }
      const anchorSeeds = crawlScopes.length === 1
        ? allSeeds
        : allSeeds.filter(s => {
            try {
              const p = new URL(s);
              return p.origin === origin && p.pathname.toLowerCase().startsWith(scopePath.toLowerCase());
            } catch { return false; }
          });
      log(`    [${langLabels[l]}] crawling anchor ${scopePath}/ (seeds=${anchorSeeds.length}, cap=${perAnchorCap})`);
      const scopeCopy = scope;
      crawlPromises.push(
        crawlDirectory(origin, scopeCopy, (c, q) => {
          if (c > 0 && c % 100 === 0) log(`      [${langLabels[l]}] ${scopePath}/ progress: ${c} pages, ${q} queued`);
        }, anchorSeeds, control.signal, perAnchorCap).then(inv => {
          crawlCache.set(cacheKey, inv);
          perLangInvs[l].push(inv);
          const status = inv.urls.size === 0 ? " (NO PAGES — possible bad anchor)" : "";
          log(`    [${langLabels[l]}] anchor ${scopePath}/ complete: fetched=${inv.urls.size} titled=${inv.titleIndex.size}${status}`);
        })
      );
    }
  }

  if (crawlPromises.length > 0) await Promise.all(crawlPromises);

  for (const l of langs) {
    if (perLangInvs[l].length === 0) continue;
    inventories[l] = perLangInvs[l].length === 1 ? perLangInvs[l][0] : mergeInventories(perLangInvs[l]);
    const total = inventories[l]?.urls.size ?? 0;
    const titles = inventories[l]?.titleIndex.size ?? 0;
    log(`  ${langLabels[l]} inventory total: ${total} URLs (${titles} titled) across ${perLangInvs[l].length} anchor crawl(s)`);
  }

  // ---- MAPPED-SUBTREE COVERAGE AUDIT + BACKFILL ----
  // For every learned per-pair (sourceRoot → targetRoot) mapping, count how
  // many inventory URLs sit under the mapped target subtree. Any subtree with
  // fewer than COVERAGE_MIN_THRESHOLD URLs is sparse — typically the result
  // of the link extractor having no inbound links to its leaf pages other
  // than via the SharePoint folder-listing UI. For each sparse subtree we
  // run a bounded targeted re-crawl pass scoped to the subtree itself,
  // seeding `Pages/`, `Pages/default.aspx`, and `Pages/Forms/AllItems.aspx`
  // (the listing page now exposes its child links since the scraper change).
  const COVERAGE_MIN_THRESHOLD = 3;
  // Defaults raised (200→500, 50→100) to cover deeper RU/AR subtrees that the
  // initial crawl misses. Override with env vars when profiling cost vs. recall.
  const BACKFILL_CAP_PER_SUBTREE = parseInt(process.env.LINGUAMAP_BACKFILL_CAP_PER_SUBTREE || "500", 10);
  const MAX_BACKFILL_SUBTREES_PER_LANG = parseInt(process.env.LINGUAMAP_MAX_BACKFILL_SUBTREES || "100", 10);
  const coverageStats: Record<TargetLang, { totalInventory: number; mappedSubtrees: number; sparseBefore: number; sparseAfter: number; backfilledUrls: number }> = {
    en: { totalInventory: 0, mappedSubtrees: 0, sparseBefore: 0, sparseAfter: 0, backfilledUrls: 0 },
    fr: { totalInventory: 0, mappedSubtrees: 0, sparseBefore: 0, sparseAfter: 0, backfilledUrls: 0 },
    ru: { totalInventory: 0, mappedSubtrees: 0, sparseBefore: 0, sparseAfter: 0, backfilledUrls: 0 },
    ar: { totalInventory: 0, mappedSubtrees: 0, sparseBefore: 0, sparseAfter: 0, backfilledUrls: 0 },
  };

  function countUrlsUnder(inv: CrawlInventory, prefix: string): number {
    const lower = prefix.toLowerCase();
    let n = 0;
    for (const u of Array.from(inv.urls)) {
      try {
        const p = new URL(u).pathname.toLowerCase();
        if (p === lower || p.startsWith(lower)) n++;
      } catch {}
    }
    return n;
  }

  function findSourceRowForMapping(targetRoot: string[], lang: TargetLang): string | null {
    const tgtKey = "/" + targetRoot.map(s => s.toLowerCase()).join("/") + "/";
    for (const ref of tabRefRows) {
      const url = ref[refUrlKey[lang]];
      if (!url) continue;
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (p === tgtKey || p.startsWith(tgtKey)) return ref.sourceUrl;
      } catch {}
    }
    return null;
  }

  if (origin) {
    for (const l of langs) {
      if (control.cancel) break;
      const inv = inventories[l];
      if (!inv) continue;
      const pairMappings = tabPatterns.rootMappings.get(l) || [];
      if (pairMappings.length === 0) continue;

      const seenTgt = new Set<string>();
      const subtrees: { targetRoot: string[]; pathPrefix: string }[] = [];
      for (const m of pairMappings) {
        if (m.targetRoot.length === 0) continue;
        const key = m.targetRoot.map(s => s.toLowerCase()).join("/");
        if (seenTgt.has(key)) continue;
        seenTgt.add(key);
        subtrees.push({ targetRoot: m.targetRoot, pathPrefix: "/" + m.targetRoot.join("/") + "/" });
      }
      coverageStats[l].mappedSubtrees = subtrees.length;
      if (subtrees.length === 0) continue;

      const sparseSubtrees: { targetRoot: string[]; pathPrefix: string; before: number }[] = [];
      for (const st of subtrees) {
        const before = countUrlsUnder(inv, st.pathPrefix);
        if (before < COVERAGE_MIN_THRESHOLD) {
          sparseSubtrees.push({ ...st, before });
          const sourceRow = findSourceRowForMapping(st.targetRoot, l);
          log(`  ${langLabels[l]} coverage WARN: mapped subtree ${st.pathPrefix} has only ${before} inventory URL(s)${sourceRow ? ` (e.g. source row ${sourceRow})` : ""}`);
        }
      }
      coverageStats[l].sparseBefore = sparseSubtrees.length;
      if (sparseSubtrees.length === 0) continue;

      const cappedSparse = sparseSubtrees.slice(0, MAX_BACKFILL_SUBTREES_PER_LANG);
      if (cappedSparse.length < sparseSubtrees.length) {
        log(`  ${langLabels[l]} coverage backfill: ${sparseSubtrees.length} sparse subtree(s) found, backfilling first ${cappedSparse.length} (per-lang cap)`);
      } else {
        log(`  ${langLabels[l]} coverage backfill: re-crawling ${cappedSparse.length} sparse subtree(s) (cap ${BACKFILL_CAP_PER_SUBTREE} pages each)`);
      }

      const backfillInvs: CrawlInventory[] = [];
      let addedTotal = 0;
      for (const st of cappedSparse) {
        if (control.cancel) break;
        const subtreeOriginPath = origin + st.pathPrefix;
        const seeds = [
          subtreeOriginPath + "Pages/",
          subtreeOriginPath + "Pages/default.aspx",
          subtreeOriginPath + "Pages/Forms/AllItems.aspx",
        ];
        try {
          const subInv = await crawlDirectory(
            origin,
            st.targetRoot,
            undefined,
            seeds,
            control.signal,
            BACKFILL_CAP_PER_SUBTREE,
          );
          if (subInv.urls.size > 0) {
            backfillInvs.push(subInv);
            addedTotal += subInv.urls.size;
          }
        } catch (e) {
          log(`    ${langLabels[l]} backfill failed for ${st.pathPrefix}: ${(e as Error).message}`);
        }
      }

      if (backfillInvs.length > 0) {
        const before = inv.urls.size;
        const merged = mergeInventories([inv, ...backfillInvs]);
        if (merged) inventories[l] = merged;
        const after = inventories[l]?.urls.size ?? before;
        coverageStats[l].backfilledUrls = after - before;
        log(`  ${langLabels[l]} coverage backfill complete: discovered ${addedTotal} URL(s) across ${backfillInvs.length} subtree(s); inventory ${before} → ${after} (+${after - before} unique)`);
      }

      const newInv = inventories[l]!;
      let stillSparse = 0;
      for (const st of subtrees) {
        if (countUrlsUnder(newInv, st.pathPrefix) < COVERAGE_MIN_THRESHOLD) stillSparse++;
      }
      coverageStats[l].sparseAfter = stillSparse;
      if (stillSparse > 0) {
        log(`  ${langLabels[l]} coverage post-backfill: ${stillSparse} mapped subtree(s) STILL below threshold (${COVERAGE_MIN_THRESHOLD} URLs)`);
      }
    }
  }

  for (const l of langs) {
    coverageStats[l].totalInventory = inventories[l]?.urls.size ?? 0;
  }

  // ---- COVERAGE DIAGNOSTIC ----
  // Per-language: of the predicted target URLs constructed from every source
  // row, how many are actually present in the crawled inventory? Surface this
  // BEFORE the AI step so a future inventory regression is obvious in 30
  // seconds rather than after a full AI run.
  // Also: capture every "missing subtree" path with count >= FEEDBACK_MIN_MISS
  // into newFeedbackAnchors so the next pass can HEAD-probe those subtrees and
  // seed crawl from any survivors.
  const FEEDBACK_MIN_MISS = 50;
  const newFeedbackAnchors: Record<TargetLang, string[]> = { en: [], fr: [], ru: [], ar: [] };
  for (const l of langs) {
    const inv = inventories[l];
    if (!inv) continue;
    const predictedSet = new Set<string>();
    let rowsContributing = 0;
    for (const row of allRows) {
      const cs = constructAllTargetUrls(row.sourceUrl, l, tabPatterns);
      if (cs.length === 0) continue;
      rowsContributing++;
      for (const c of cs) predictedSet.add(c);
    }
    if (predictedSet.size === 0) continue;
    let present = 0;
    const missingByPrefix = new Map<string, number>();
    for (const c of Array.from(predictedSet)) {
      if (inv.urls.has(c)) {
        present++;
      } else {
        try {
          const parts = new URL(c).pathname.split("/").filter(Boolean);
          const stripped = parts.filter(p => !/\.aspx$/i.test(p) && p.toLowerCase() !== "pages");
          const key = stripped.slice(0, 3).join("/");
          if (key) missingByPrefix.set(key, (missingByPrefix.get(key) || 0) + 1);
        } catch {}
      }
    }
    const pct = predictedSet.size > 0 ? (present / predictedSet.size * 100).toFixed(1) : "0.0";
    log(`  ${langLabels[l]} coverage: predicted ${predictedSet.size} target URLs from ${rowsContributing} source rows, ${present} present in inventory (${present}/${predictedSet.size} = ${pct}%)`);
    const missingTotal = predictedSet.size - present;
    if (missingTotal > 0 && missingByPrefix.size > 0) {
      const sorted = Array.from(missingByPrefix.entries()).sort((a, b) => b[1] - a[1]);
      const top = sorted.slice(0, 5);
      for (const [prefix, count] of top) {
        log(`    ${langLabels[l]} missing subtree: /${prefix}/: ${count} URLs`);
      }
      const alreadyProbedPaths = new Set<string>();
      for (const u of Array.from(feedbackAliveByLang[l])) {
        try { alreadyProbedPaths.add(new URL(u).pathname.replace(/^\/+|\/+$/g, "")); } catch {}
      }
      for (const [prefix, count] of sorted) {
        if (count < FEEDBACK_MIN_MISS) break;
        if (alreadyProbedPaths.has(prefix)) continue;
        newFeedbackAnchors[l].push(prefix);
      }
      if (newFeedbackAnchors[l].length > 0) {
        log(`    ${langLabels[l]} captured ${newFeedbackAnchors[l].length} feedback anchor path(s) for next pass (>=${FEEDBACK_MIN_MISS} missing each)`);
      }
    }
  }

  // ---- INVENTORY TAIL-PAIR SEGMENT MINING ----
  // For each unmatched HE source URL, look up inventory URLs of the same inner
  // length sharing at least one identical positional segment. For each such
  // pairing, vote on positions where segments differ. Promote (heSeg→tgtSeg)
  // when supported by >=2 distinct pairings and a clear winner. Mined segments
  // are merged into tabPatterns.segmentMap (without overwriting confirmed) for
  // the rest of this tab AND returned for the global registry.
  const minedSegments: Record<TargetLang, Map<string, string>> = { en: new Map(), fr: new Map(), ru: new Map(), ar: new Map() };
  {
    const refSourceSet = new Set<string>();
    for (const ref of tabRefRows) refSourceSet.add(ref.sourceUrl);
    const unmatchedSources: string[] = [];
    for (const row of allRows) {
      if (refSourceSet.has(row.sourceUrl)) continue;
      if (langs.some(l => row[needsKey[l]])) unmatchedSources.push(row.sourceUrl);
    }
    if (unmatchedSources.length > 0) {
      for (const l of langs) {
        const inv = inventories[l];
        if (!inv) continue;
        const beforeSize = tabPatterns.segmentMap.get(l)?.size || 0;
        const result = mineSegmentsFromInventory(unmatchedSources, inv, tabPatterns, l, { pairingCap: 10000 });
        if (result.promoted > 0) {
          let segMap = tabPatterns.segmentMap.get(l);
          if (!segMap) { segMap = new Map(); tabPatterns.segmentMap.set(l, segMap); }
          for (const [k, v] of Array.from(result.segments.entries())) {
            if (!segMap.has(k)) {
              segMap.set(k, v);
              minedSegments[l].set(k, v);
            }
          }
          const after = tabPatterns.segmentMap.get(l)?.size || beforeSize;
          const sample = Array.from(minedSegments[l].entries()).slice(0, 6).map(([k, v]) => `${k}→${v}`).join(", ");
          log(`  ${langLabels[l]} inventory mining: ${result.pairings} pairings, ${minedSegments[l].size} new segment(s) promoted (segMap ${beforeSize}→${after})${sample ? `; sample: ${sample}` : ""}`);
        } else if (result.pairings > 0) {
          log(`  ${langLabels[l]} inventory mining: ${result.pairings} pairings, 0 segments promoted (no candidate reached ${2} votes)`);
        }
      }
    }
  }

  const SEED_VERIFY_CEILING = 3000;
  const verifyPromises: Promise<void>[] = [];
  for (const l of langs) {
    const inv = inventories[l];
    if (!inv) continue;
    const userSeed = userSeedSegs[l];
    const userScopePath = userSeed ? "/" + userSeed.join("/") : null;
    const refSeeds: string[] = [];
    const seenSeed = new Set<string>();
    let droppedOutOfScope = 0;
    for (const ref of tabRefRows) {
      const url = ref[refUrlKey[l]];
      if (!url || seenSeed.has(url)) continue;
      seenSeed.add(url);
      try {
        const p = new URL(url);
        if (p.origin !== origin) continue;
        if (userScopePath) {
          const pn = p.pathname.toLowerCase();
          const sc = userScopePath.toLowerCase();
          if (pn !== sc && !pn.startsWith(sc + "/")) {
            droppedOutOfScope++;
            continue;
          }
        }
      } catch { continue; }
      refSeeds.push(url);
    }
    if (userScopePath && droppedOutOfScope > 0) {
      log(`  ${langLabels[l]} seed verification: dropped ${droppedOutOfScope} ref URL(s) outside user-provided scope ${userScopePath}/`);
    }
    if (refSeeds.length === 0) continue;
    verifyPromises.push(
      verifySeedUrls(inv, refSeeds, control.signal, SEED_VERIFY_CEILING).then(stats => {
        const before = inv.urls.size - stats.added;
        log(`  ${langLabels[l]} seed verification: checked=${stats.checked}, added=${stats.added}, skipped_known=${stats.skippedKnown}, failed=${stats.failed}${stats.capped ? `, capped_off=${stats.capped}` : ""} (inventory ${before} → ${inv.urls.size})`);
      })
    );
  }
  if (verifyPromises.length > 0) await Promise.all(verifyPromises);

  for (const ref of tabRefRows) {
    for (const l of langs) {
      const url = ref[refUrlKey[l]];
      if (url) usedUrls[l].add(url);
    }
  }

  const unmatchedForHead: { index: number; lang: TargetLang; constructedUrl: string; sourceUrl: string }[] = [];
  const debugSamples: Record<string, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
  const MAX_DEBUG_SAMPLES = 15;
  const methodCounts: Record<string, number> = {};
  let inventoryMatchCount = 0;
  let inventoryMissCount = 0;
  let dedupBlockedCount = 0;
  const sectionStats: Record<string, Record<string, number>> = {};

  function getSection(sourceUrl: string): string {
    try {
      const parsed = new URL(sourceUrl);
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0] || "root";
    } catch { return "unknown"; }
  }

  for (const row of needsMatching) {
    if (control.cancel) break;
    const section = getSection(row.sourceUrl);
    if (!sectionStats[section]) {
      sectionStats[section] = {};
      for (const l of langs) { sectionStats[section][`${l}Matched`] = 0; sectionStats[section][`${l}Missed`] = 0; }
    }

    const result = emptyBatchResult();

    for (const l of langs) {
      if (row[needsKey[l]] && tabPatterns.patternValidated[l] && inventories[l]) {
        const match = matchAgainstInventory(row.sourceUrl, l, tabPatterns, inventories[l]!);
        // Sibling-scope hard fence (Task #70). When this row's source URL is
        // covered by a confirmed (sourceRoot → targetRoot) per-pair mapping,
        // the matched URL MUST live under the mapped target subtree even when
        // pattern+crawl produced it. A blank cell is preferred over a
        // wrong-section commit. Fall through to the candidate construction
        // path so HEAD/AI can still try other in-scope URLs.
        let scopeBlocked = false;
        if (match) {
          const scope = computeSiblingScope(row.sourceUrl, l, tabPatterns);
          if (scope && !isUrlUnderTgtDir(match.url, scope.mappedTgtDir)) {
            scopeBlocked = true;
            titleFenceRejected[l]++;
            titleFenceMarks[l].add(row.rowIndex);
            log(`    Pattern+crawl REJECTED (sibling-scope fence): ${l.toUpperCase()} ${match.url} ⟵ ${row.sourceUrl}`);
          }
        }
        if (match && !scopeBlocked && !usedUrls[l].has(match.url)) {
          // Pass crossScript so AI/title flags can later distinguish
          // genuine cross-script matches from same-script ones; pattern+crawl
          // commits don't run inside a sibling-scope context here so scoped=false.
          setResultMatch(result, l, match.url, match.confidence, match.method, {
            crossScript: crossScriptLangs[l] === true,
          });
          usedUrls[l].add(match.url);
          methodCounts[match.method] = (methodCounts[match.method] || 0) + 1;
          inventoryMatchCount++;
          sectionStats[section][`${l}Matched`]++;
        } else {
          if (match) dedupBlockedCount++; else inventoryMissCount++;
          sectionStats[section][`${l}Missed`]++;
          // Pattern miss → non-fence failure for strict fence-only telemetry,
          // BUT only when the failure was not itself caused by the sibling
          // fence. If `scopeBlocked` is true the row's pattern miss IS the
          // fence rejection and we must not also add it to the non-fence
          // bucket — doing so would suppress a legitimate fence-only row in
          // the strict counter.
          if (!scopeBlocked) titleNonFenceFailureMarks[l].add(row.rowIndex);
          const allCandidates = constructAllTargetUrls(row.sourceUrl, l, tabPatterns);
          if (debugSamples[l] < MAX_DEBUG_SAMPLES) {
            const reason = match ? `dedup-blocked (${match.url})` : "not-in-inventory";
            log(`    [DEBUG] ${langLabels[l]} miss: ${row.sourceUrl}`);
            log(`      candidates: ${allCandidates.length} URLs | reason: ${reason}`);
            for (const c of allCandidates.slice(0, 5)) {
              log(`        ${c} | inInventory: ${inventories[l]!.urls.has(c)}`);
            }
            debugSamples[l]++;
          }
          // Sibling-scope hard fence (Task #70). Pre-filter constructed
          // candidates so HEAD only verifies in-scope URLs. This both
          // prevents double-counting rejections (the pattern stage already
          // counted any out-of-scope dedup-blocked URL via scopeBlocked) and
          // saves needless HEAD requests against URLs that would be rejected
          // at commit time anyway.
          const headScope = computeSiblingScope(row.sourceUrl, l, tabPatterns);
          for (const candidate of allCandidates) {
            if (usedUrls[l].has(candidate)) continue;
            if (headScope && !isUrlUnderTgtDir(candidate, headScope.mappedTgtDir)) continue;
            unmatchedForHead.push({ index: row.rowIndex, lang: l, constructedUrl: candidate, sourceUrl: row.sourceUrl });
          }
        }
      }
    }

    matchResults.set(row.rowIndex, result);
  }

  const methodSummary = Object.entries(methodCounts).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}:${c}`).join(", ");
  log(`  Pattern+Crawl stage: ${inventoryMatchCount} matched (${methodSummary || "none"}), ${inventoryMissCount} missed, ${dedupBlockedCount} dedup-blocked`);
  log(`  HEAD candidates: ${unmatchedForHead.length} URLs to verify`);

  const sectionsWithMisses = Object.entries(sectionStats)
    .filter(([, s]) => langs.some(l => (s[`${l}Missed`] || 0) > 0))
    .sort((a, b) => {
      const aMiss = langs.reduce((sum, l) => sum + (a[1][`${l}Missed`] || 0), 0);
      const bMiss = langs.reduce((sum, l) => sum + (b[1][`${l}Missed`] || 0), 0);
      return bMiss - aMiss;
    });
  if (sectionsWithMisses.length > 0) {
    log(`  Section breakdown (sections with misses):`);
    for (const [sec, s] of sectionsWithMisses.slice(0, 20)) {
      const parts = langs.map(l => `${langLabels[l]} ${s[`${l}Matched`] || 0}✓/${s[`${l}Missed`] || 0}✗`);
      log(`    ${sec}: ${parts.join(" | ")}`);
    }
  }

  // ---- PASS 1.5: ALTERNATE-LINK HARVEST ----
  // For rows that Pattern+Crawl couldn't place, fetch the source HTML once
  // and look for `<link rel="alternate" hreflang>` (and `<a hreflang>`) that
  // points into our crawled inventory. This is especially valuable on
  // cross-script tabs where the segment learner has no usable training pairs.
  // Run harvest whenever any lang still has unmatched rows and a crawled
  // inventory. The 1500-source cap already bounds cost. The old gate
  // (crossScriptLangs only) skipped tabs with too few RU/AR ref pairs —
  // exactly the tabs where hreflang discovery matters most.
  const harvestNeeded = langs.some(l => inventories[l] && needsMatching.some(r => {
    const m = matchResults.get(r.rowIndex);
    return r[needsKey[l]] && (!m || !getResultUrl(m, l));
  }));
  if (harvestNeeded) {
    // Group missed rows by sourceUrl so duplicate sources are fetched once and
    // every row sharing that source benefits from any found alternate links.
    // The merged `needs` is the union across all rows for that source URL.
    const sourceToRows = new Map<string, { rowIndexes: number[]; needs: Partial<Record<TargetLang, boolean>> }>();
    for (const row of needsMatching) {
      const m = matchResults.get(row.rowIndex);
      let any = false;
      const rowNeeds: Partial<Record<TargetLang, boolean>> = {};
      for (const l of langs) {
        if (row[needsKey[l]] && (!m || !getResultUrl(m, l)) && inventories[l]) {
          rowNeeds[l] = true;
          any = true;
        }
      }
      if (!any) continue;
      const existing = sourceToRows.get(row.sourceUrl);
      if (existing) {
        existing.rowIndexes.push(row.rowIndex);
        for (const l of langs) if (rowNeeds[l]) existing.needs[l] = true;
      } else {
        sourceToRows.set(row.sourceUrl, { rowIndexes: [row.rowIndex], needs: rowNeeds });
      }
    }
    if (sourceToRows.size > 0) {
      const HARVEST_CAP = 1500;
      const allEntries = Array.from(sourceToRows.entries());
      const cappedEntries = allEntries.slice(0, HARVEST_CAP);
      const capped = cappedEntries.map(([sourceUrl, v]) => ({ sourceUrl, needs: v.needs }));
      log(`  Pass 1.5 alternate-link harvest: ${capped.length}${allEntries.length > capped.length ? `/${allEntries.length} (capped)` : ""} unique source pages, scanning for hreflang links${alternateLinkCache ? " (with per-job cache)" : ""}...`);
      // Per-row needs are carried into the apply phase so a row that doesn't need
      // a given lang cannot accidentally consume the inventory URL via usedUrls
      // and starve a sibling row that does need it.
      const rowNeedsByIndex = new Map<number, Partial<Record<TargetLang, boolean>>>();
      for (const row of needsMatching) {
        const m = matchResults.get(row.rowIndex);
        const rn: Partial<Record<TargetLang, boolean>> = {};
        for (const l of langs) {
          if (row[needsKey[l]] && (!m || !getResultUrl(m, l)) && inventories[l]) rn[l] = true;
        }
        rowNeedsByIndex.set(row.rowIndex, rn);
      }
      const harvest = await harvestAlternateLinks(capped, inventories, control.signal, 6, alternateLinkCache);
      let harvestApplied = 0;
      for (const [sourceUrl, found] of Array.from(harvest.matches.entries())) {
        const group = sourceToRows.get(sourceUrl);
        if (!group) continue;
        for (const rowIndex of group.rowIndexes) {
          const rowNeeds = rowNeedsByIndex.get(rowIndex);
          if (!rowNeeds) continue;
          let result = matchResults.get(rowIndex);
          if (!result) {
            result = emptyBatchResult();
            matchResults.set(rowIndex, result);
          }
          for (const l of langs) {
            if (!rowNeeds[l]) continue;
            const url = found[l];
            if (!url) continue;
            if (getResultUrl(result, l)) continue;
            if (usedUrls[l].has(url)) continue;
            // Sibling-scope hard fence (Task #70). Pass 1.5 alternate-link
            // harvest reads <link rel="alternate" hreflang> tags from the HE
            // page, which the BTL CMS can publish even when the linked
            // target page lives outside the per-pair mapped subtree. Apply
            // the same fence as the title/AI commits so the architectural
            // guarantee is global: a row with a confirmed sibling scope
            // never commits a target outside its mapped subtree, even if a
            // hreflang link points there. Out-of-scope harvest hits count
            // as fence rejections at the title stage.
            const scope = computeSiblingScope(sourceUrl, l, tabPatterns);
            if (scope && !isUrlUnderTgtDir(url, scope.mappedTgtDir)) {
              titleFenceRejected[l]++;
              titleFenceMarks[l].add(rowIndex);
              log(`    Pass 1.5 alt-link REJECTED (sibling-scope fence): ${l.toUpperCase()} ${url} ⟵ ${sourceUrl}`);
              continue;
            }
            // alt-link: scoped reflects whether a sibling scope was active
            // for this row+lang; crossScript carries the per-tab flag.
            setResultMatch(result, l, url, 95, "alternate-link", {
              scoped: scope !== null,
              crossScript: crossScriptLangs[l] === true,
            });
            usedUrls[l].add(url);
            harvestApplied++;
          }
        }
      }
      const perLangAcc = langs.map(l => `${l.toUpperCase()}:${harvest.perLangAccepted[l]}`).join(", ");
      const perLangRej = langs.map(l => `${l.toUpperCase()}:${harvest.perLangRejectedNotInInventory[l]}`).join(", ");
      log(`  Pass 1.5 harvest: attempted=${harvest.attempted}, fetched=${harvest.fetched}, cacheHits=${harvest.cacheHits}, pagesWithAnyAlternate=${harvest.pagesWithAnyAlternate}, pagesWithInventoryHit=${harvest.pagesWithInventoryHit}`);
      log(`  Pass 1.5 harvest: accepted (${perLangAcc}), rejected-not-in-inventory (${perLangRej}), applied=${harvestApplied} match(es) across ${needsMatching.length} unmatched rows`);
    }
  }

  // ---- INVENTORY TITLE-MATCH STAGE (before HEAD) ----
  // Trust inventory title matches above the configured similarity threshold,
  // skipping HEAD verification for accepted matches. HEAD becomes a last-ditch
  // fallback for rows the inventory could not satisfy.
  const unmatchedForTitle = needsMatching.filter(row => {
    const m = matchResults.get(row.rowIndex);
    return row.title && langs.some(l =>
      row[needsKey[l]] && (!m || !getResultUrl(m, l))
    );
  }).map(row => {
    const m = matchResults.get(row.rowIndex);
    const needs: Record<TargetLang, boolean> = { en: false, fr: false, ru: false, ar: false };
    for (const l of langs) {
      needs[l] = !!(row[needsKey[l]] && (!m || !getResultUrl(m, l)));
    }
    return { rowIndex: row.rowIndex, title: row.title, sourceUrl: row.sourceUrl, needs };
  });

  const hasAnyInventory = langs.some(l => inventories[l] !== null);
  let titleAcceptedTotal = 0;
  const titleMethodCounts: Record<string, number> = {};
  if (unmatchedForTitle.length > 0 && hasAnyInventory) {
    log(`  Inventory title-match stage: scoring ${unmatchedForTitle.length} unmatched rows against per-lang inventory...`);
    for (const l of langs) {
      const inv = inventories[l];
      log(`    ${langLabels[l]} inventory: ${inv ? `${inv.urls.size} URLs, ${inv.titleIndex.size} titles` : 'null'}`);
    }

    const allowedRoots: Record<TargetLang, string[]> = { en: [], fr: [], ru: [], ar: [] };
    for (const l of langs) {
      const rootSet = new Set<string>();
      const root = langRoot(tabPatterns, l);
      if (root.length > 0) rootSet.add("/" + root.join("/") + "/");
      for (const ref of tabRefRows) {
        const url = ref[refUrlKey[l]];
        if (url) {
          try {
            const parts = new URL(url).pathname.split("/").filter(Boolean);
            if (parts.length >= 2) rootSet.add("/" + parts.slice(0, 2).join("/") + "/");
            else if (parts.length >= 1) rootSet.add("/" + parts[0] + "/");
          } catch {}
        }
      }
      allowedRoots[l] = Array.from(rootSet);
      if (allowedRoots[l].length > 0) log(`    ${langLabels[l]} allowed roots: ${allowedRoots[l].join(", ")}`);
      else log(`    ${langLabels[l]} title matching SKIPPED: no allowed roots could be determined`);
    }

    const refDepths: Record<TargetLang, number[] | undefined> = { en: undefined, fr: undefined, ru: undefined, ar: undefined };
    const knownUrlSets: Record<TargetLang, Set<string>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };
    for (const l of langs) {
      const depths: number[] = [];
      for (const ref of tabRefRows) {
        const url = ref[refUrlKey[l]];
        if (url) {
          try {
            depths.push(new URL(url).pathname.split("/").filter(Boolean).length);
            knownUrlSets[l].add(url);
          } catch {}
        }
      }
      refDepths[l] = depths.length > 0 ? depths : undefined;
      for (const [, mr] of Array.from(matchResults.entries())) {
        const u = getResultUrl(mr, l);
        if (u) knownUrlSets[l].add(u);
      }
    }

    const titleOutput = await titleMatchUnmatched(
      unmatchedForTitle, inventories, storage,
      allowedRoots, refDepths, knownUrlSets, control.signal, crossScriptLangs,
      tabPatterns, matchTrace,
    );
    const titleMatches = titleOutput.matches;
    for (const l of langs) {
      titleFenceRejected[l] += titleOutput.siblingFence[l].rejected;
      for (const idx of Array.from(titleOutput.siblingFence[l].markedRowIndices)) {
        titleFenceMarks[l].add(idx);
      }
      // Merge title-stage non-fence failure rows (matcher returned nothing
      // for reasons unrelated to the sibling fence: no candidate found, all
      // candidates already used, etc.) so the strict fence-only-blocked
      // metric correctly disqualifies these rows.
      for (const idx of Array.from(titleOutput.siblingFence[l].nonFenceFailureRowIndices)) {
        titleNonFenceFailureMarks[l].add(idx);
      }
      // Task #74: accumulate scope-active loosened admissions reported by
      // the title matcher. Sums per-lang across multiple title-stage calls
      // within the same tab; surfaced in processJob's per-tab summary line.
      titleLoosenedAccepted[l] += titleOutput.loosenedAccepted[l];
    }

    for (const [rowIndex, titleResult] of Array.from(titleMatches.entries())) {
      let result = matchResults.get(rowIndex);
      if (!result) {
        result = emptyBatchResult();
        matchResults.set(rowIndex, result);
      }
      for (const l of langs) {
        const tUrl = getResultUrl(titleResult, l);
        if (tUrl && !getResultUrl(result, l) && !usedUrls[l].has(tUrl)) {
          const method = getResultMethod(titleResult, l) || "";
          let taggedMethod: string;
          if (method === "title-match" || method === "") taggedMethod = "inventory-title";
          else if (method === "title-section-match") taggedMethod = "inventory-title+section";
          else if (method === "title-disambig") taggedMethod = "inventory-title+disambig";
          else if (method === "title-semantic") taggedMethod = "inventory-title-semantic";
          else if (method === "title-semantic+disambig") taggedMethod = "inventory-title-semantic+disambig";
          else taggedMethod = `inventory-${method}`;
          // Preserve scoped/crossScript flags captured by the title matcher.
          setResultMatch(result, l, tUrl, getResultConf(titleResult, l) || 0, taggedMethod, getResultFlags(titleResult, l) ?? undefined);
          usedUrls[l].add(tUrl);
          titleAcceptedTotal++;
          titleMethodCounts[taggedMethod] = (titleMethodCounts[taggedMethod] || 0) + 1;
        } else if (tUrl) {
          // Title produced a candidate but the post-candidate commit gates
          // (slot-already-filled by an earlier stage, or URL-already-used by
          // another row's earlier commit) blocked it. These are non-fence
          // commit failures and must mark the row so the strict
          // "fence-only" telemetry doesn't misattribute them.
          titleNonFenceFailureMarks[l].add(rowIndex);
        }
      }
    }
    const titleSummary = Object.entries(titleMethodCounts).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}:${c}`).join(", ");
    log(`  Inventory title-match: ${titleAcceptedTotal} accepted (${titleSummary || "none"})`);
  }

  // ---- HEAD FALLBACK (last-ditch only for rows inventory + title couldn't satisfy) ----
  // Drop HEAD candidates whose row+lang got filled by the title-match stage above.
  const remainingForHead = unmatchedForHead.filter(u => {
    const result = matchResults.get(u.index);
    return !result || !getResultUrl(result, u.lang);
  });
  const forwardedToHead = remainingForHead.length;
  const skippedAfterTitle = unmatchedForHead.length - forwardedToHead;
  log(`  Inventory title-match summary: ${titleAcceptedTotal} accepted (≥threshold), ${forwardedToHead} borderline forwarded to HEAD${skippedAfterTitle > 0 ? ` (${skippedAfterTitle} HEAD candidates dropped because title-match already filled their slot)` : ""}`);

  const asciiOnly = remainingForHead.filter(u => {
    try {
      const decoded = decodeURIComponent(new URL(u.constructedUrl).pathname);
      return !/[\u0590-\u05FF\u0600-\u06FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(decoded);
    } catch { return false; }
  });
  const skippedNonAscii = remainingForHead.length - asciiOnly.length;
  if (skippedNonAscii > 0) {
    log(`  Skipping ${skippedNonAscii} HEAD candidates with Hebrew/Arabic path segments`);
  }

  if (asciiOnly.length > 0) {
    log(`  HEAD last-ditch fallback for ${asciiOnly.length} URLs (timeout: 12s, concurrency: 10)...`);
    for (let s = 0; s < Math.min(5, asciiOnly.length); s++) {
      log(`    [HEAD sample] ${asciiOnly[s].sourceUrl} → ${asciiOnly[s].constructedUrl}`);
    }
    const headUrls = asciiOnly.map((u) => u.constructedUrl);
    const existence = await batchHeadCheck(headUrls, control.signal);
    const headVerified = Array.from(existence.values()).filter(v => v.ok).length;
    const headFailed = Array.from(existence.values()).filter(v => !v.ok).length;
    log(`  HEAD results: ${headVerified} verified, ${headFailed} failed out of ${existence.size} checked`);
    let headMatched = 0;
    let headDepthRejected = 0;
    let headRedirRescued = 0;

    for (const item of asciiOnly) {
      const probe = existence.get(item.constructedUrl);
      if (probe && probe.ok) {
        const verifiedUrl = probe.finalUrl || item.constructedUrl;
        const wasRedirected = verifiedUrl !== item.constructedUrl;
        const srcRoot = langSrcRoot(tabPatterns, item.lang);
        const tgtRoot = langRoot(tabPatterns, item.lang);

        try {
          const srcParts = new URL(item.sourceUrl).pathname.split("/").filter(Boolean);
          const srcDepth = srcParts.length - srcRoot.length;
          const tgtParts = new URL(verifiedUrl).pathname.split("/").filter(Boolean);
          const tgtDepth = tgtParts.length - tgtRoot.length;
          if (srcDepth >= 2 && tgtDepth <= 0) {
            log(`    HEAD match REJECTED (parent-only): ${item.sourceUrl} -> ${verifiedUrl}`);
            headDepthRejected++;
            titleNonFenceFailureMarks[item.lang].add(item.index);
            continue;
          }
          if (srcDepth >= 3 && tgtDepth <= 1) {
            log(`    HEAD match REJECTED (too shallow): ${item.sourceUrl} -> ${verifiedUrl}`);
            headDepthRejected++;
            titleNonFenceFailureMarks[item.lang].add(item.index);
            continue;
          }
        } catch {}

        if (usedUrls[item.lang].has(verifiedUrl)) continue;

        // Sibling-scope hard fence (Task #70). HEAD-verified candidates were
        // constructed by the pattern path and may live outside the per-pair
        // mappedTgtDir; reject those before commit so a wrong-section URL is
        // never written to the workbook even if the page exists.
        const scope = computeSiblingScope(item.sourceUrl, item.lang, tabPatterns);
        if (scope && !isUrlUnderTgtDir(verifiedUrl, scope.mappedTgtDir)) {
          titleFenceRejected[item.lang]++;
          titleFenceMarks[item.lang].add(item.index);
          log(`    HEAD REJECTED (sibling-scope fence): ${item.lang.toUpperCase()} ${verifiedUrl} ⟵ ${item.sourceUrl}`);
          continue;
        }

        const result = matchResults.get(item.index);
        if (result && !getResultUrl(result, item.lang)) {
          const method = wasRedirected ? "head-verified+redirect" : "head-verified";
          // HEAD-verified candidates carry their per-row sibling-scope status
          // and the per-tab cross-script flag for the target language.
          setResultMatch(result, item.lang, verifiedUrl, 90, method, {
            scoped: scope !== null,
            crossScript: crossScriptLangs[item.lang] === true,
          });
          usedUrls[item.lang].add(verifiedUrl);
          headMatched++;
          if (wasRedirected) headRedirRescued++;
        }
      }
    }
    log(`  HEAD fallback: ${headMatched}/${asciiOnly.length} verified${headDepthRejected > 0 ? `, ${headDepthRejected} depth-rejected` : ''}${headRedirRescued > 0 ? `, ${headRedirRescued} via redirect rescue` : ''}`);
  }

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

  function dedupLang(lang: TargetLang) {
    const urlToRows = new Map<string, { rowIndex: number; confidence: number; normSource: string }[]>();
    for (const [rowIndex, result] of Array.from(matchResults.entries())) {
      const targetUrl = getResultUrl(result, lang);
      const conf = getResultConf(result, lang);
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
        if (result && getResultUrl(result, lang) === url) {
          log(`    Dedup ${langLabels[lang]} REJECTED: ${url} for row ${rows[i].rowIndex} (kept for row ${rows[0].rowIndex})`);
          clearResultMatch(result, lang);
          count++;
        }
      }
    }
    return count;
  }

  const dedupCounts: Record<string, number> = {};
  for (const l of langs) { dedupCounts[l] = dedupLang(l); }

  const dedupTotal = Object.values(dedupCounts).reduce((a, b) => a + b, 0);
  if (dedupTotal > 0) {
    const summary = langs.filter(l => dedupCounts[l] > 0).map(l => `${dedupCounts[l]} ${langLabels[l]}`).join(" and ");
    log(`  Deduplication removed ${summary} duplicate target assignments`);
  }

  // matchTab only fills in the title-stage fence here. aiRejected is left at
  // 0 and the AI-stage caller (processJob) accumulates into tabFenceStats
  // directly after each aiMatchUnmatched call.
  const fenceStats: Record<TargetLang, { titleRejected: number; aiRejected: number; markedRowIndices: Set<number>; nonFenceFailureRowIndices: Set<number> }> = {
    en: { titleRejected: titleFenceRejected.en, aiRejected: 0, markedRowIndices: titleFenceMarks.en, nonFenceFailureRowIndices: titleNonFenceFailureMarks.en },
    fr: { titleRejected: titleFenceRejected.fr, aiRejected: 0, markedRowIndices: titleFenceMarks.fr, nonFenceFailureRowIndices: titleNonFenceFailureMarks.fr },
    ru: { titleRejected: titleFenceRejected.ru, aiRejected: 0, markedRowIndices: titleFenceMarks.ru, nonFenceFailureRowIndices: titleNonFenceFailureMarks.ru },
    ar: { titleRejected: titleFenceRejected.ar, aiRejected: 0, markedRowIndices: titleFenceMarks.ar, nonFenceFailureRowIndices: titleNonFenceFailureMarks.ar },
  };
  return { matchResults, inventories, tabPatterns, usedUrls, newFeedbackAnchors, minedSegments, coverageStats, fenceStats, titleLoosenedAccepted, matchTrace };
}

async function processJob(jobId: string, _threshold: number, control: JobControl) {
  const filePath = findJobFile(jobId);
  if (!filePath) {
    throw new Error("Source file not found");
  }

  clearAllCaches();

  const workbook = await readWorkbook(filePath);
  const job = await storage.getJob(jobId);
  if (!job) throw new Error("Job not found");

  const targetLangs = (job.targetLanguages || ["en", "fr", "ru", "ar"]) as string[];
  const targetLangSet = new Set<TargetLang>(targetLangs.filter((l): l is TargetLang => l === "en" || l === "fr" || l === "ru" || l === "ar"));
  const activeLangs: TargetLang[] = (["en", "fr", "ru", "ar"] as TargetLang[]).filter(l => targetLangSet.has(l));
  log(`Job ${jobId} active target languages: ${activeLangs.map(l => l.toUpperCase()).join(", ") || "(none)"}`);

  const userCap = job.crawlPageCap || 0;
  const HARD_CAP = 10000;
  let effectiveCap: number;
  let capMode: string;
  if (userCap > 0) {
    effectiveCap = Math.min(userCap, HARD_CAP);
    capMode = `user-set (${userCap})`;
  } else {
    const totalUrls = job.totalUrls || 0;
    const scaled = Math.max(1000, totalUrls * 3);
    effectiveCap = Math.min(scaled, HARD_CAP);
    capMode = `auto (totalUrls=${totalUrls} → ${effectiveCap})`;
  }
  log(`Job ${jobId} per-section crawl page cap: ${effectiveCap} [${capMode}]`);
  let processedCount = 0;
  let matchedCount = 0;
  const startTime = Date.now();
  const crawlCache = new Map<string, CrawlInventory>();

  const allTabData: TabData[] = [];
  let seedsSheet: ExcelJS.Worksheet | null = null;
  let excludesSheet: ExcelJS.Worksheet | null = null;
  for (const worksheet of workbook.worksheets) {
    if (isSeedsSheet(worksheet.name)) {
      seedsSheet = worksheet;
      continue;
    }
    if (isExcludesSheet(worksheet.name)) {
      excludesSheet = worksheet;
      continue;
    }
    const td = parseSheet(worksheet.name, worksheet, targetLangs);
    if (td) allTabData.push(td);
  }

  const seedMap: SeedMap = seedsSheet
    ? parseSeedsSheet(seedsSheet, allTabData.map(t => t.sheetName))
    : new Map();
  if (seedsSheet) {
    if (seedMap.size === 0) {
      log(`Job ${jobId}: Seeds sheet found but no usable rows`);
    } else {
      const summary: string[] = [];
      for (const [tab, entry] of Array.from(seedMap.entries())) {
        const langs = (Object.keys(entry) as TargetLang[]).filter(l => entry[l]);
        const parts = langs.map(l => `${l.toUpperCase()}=${entry[l]}`).join(", ");
        summary.push(`"${tab}" {${parts}}`);
      }
      log(`Job ${jobId}: Seeds sheet provides overrides for ${seedMap.size} tab(s): ${summary.join("; ")}`);
    }
  }

  const excludesMap: ExcludesMap = excludesSheet
    ? parseExcludesSheet(excludesSheet, allTabData.map(t => t.sheetName))
    : new Map();
  if (excludesSheet) {
    if (excludesMap.size === 0) {
      log(`Job ${jobId}: Excludes sheet found but no usable rows`);
    } else {
      const summary: string[] = [];
      for (const [tab, entry] of Array.from(excludesMap.entries())) {
        const parts = (Object.keys(entry) as TargetLang[])
          .filter(l => entry[l] && entry[l]!.length > 0)
          .map(l => `${l.toUpperCase()}=${entry[l]!.length}`)
          .join(", ");
        summary.push(`"${tab}" {${parts}}`);
      }
      log(`Job ${jobId}: Excludes sheet provides exclusion prefixes for ${excludesMap.size} tab(s): ${summary.join("; ")}`);
    }
  }

  // Apply Excludes-sheet exclusions BEFORE the matching pipeline runs.
  // For each row whose source pathname starts with any per-language prefix
  // listed for its tab, mark needs[lang]=false and record the method as
  // "excluded-config" so the save block can surface it.
  const excludeLangs: TargetLang[] = ["en", "fr", "ru", "ar"];
  let excludedConfigCount = 0;
  for (const tabData of allTabData) {
    const tabExcl = excludesMap.get(tabData.sheetName);
    if (!tabExcl) continue;
    if (!tabData.excludedMethods) tabData.excludedMethods = new Map();
    for (const row of tabData.allRows) {
      let srcPath: string;
      try { srcPath = new URL(row.sourceUrl).pathname.toLowerCase(); }
      catch { continue; }
      for (const l of excludeLangs) {
        if (!targetLangs.includes(l)) continue;
        const prefixes = tabExcl[l];
        if (!prefixes || prefixes.length === 0) continue;
        const hit = prefixes.some(p => srcPath.startsWith(p));
        if (!hit) continue;
        switch (l) {
          case "en": if (!row.needsEn) continue; row.needsEn = false; break;
          case "fr": if (!row.needsFr) continue; row.needsFr = false; break;
          case "ru": if (!row.needsRu) continue; row.needsRu = false; break;
          case "ar": if (!row.needsAr) continue; row.needsAr = false; break;
        }
        let perRow = tabData.excludedMethods.get(row.rowIndex);
        if (!perRow) { perRow = new Map(); tabData.excludedMethods.set(row.rowIndex, perRow); }
        perRow.set(l, "excluded-config");
        excludedConfigCount++;
      }
    }
  }
  if (excludedConfigCount > 0) {
    log(`Job ${jobId}: Excludes sheet excluded ${excludedConfigCount} row+lang combinations from matching`);
  }

  const allLangs: TargetLang[] = ["en", "fr", "ru", "ar"];
  const existingKey: Record<TargetLang, keyof RowData> = { en: "existingEn", fr: "existingFr", ru: "existingRu", ar: "existingAr" };

  const activeLangsForCount: TargetLang[] = allLangs.filter(l => targetLangs.includes(l));
  let preExistingMatches = 0;
  for (const tabData of allTabData) {
    for (const row of tabData.allRows) {
      const hasAny = activeLangsForCount.some(l => !!(row[existingKey[l]] as string));
      if (hasAny) preExistingMatches++;
    }
  }
  if (preExistingMatches > 0) {
    log(`Job ${jobId} found ${preExistingMatches} pre-existing match row(s) in upload (tracked separately as "Already mapped")`);
    await storage.updateJob(jobId, { prefilledUrls: preExistingMatches });
  }
  const needsKey: Record<TargetLang, keyof RowData> = { en: "needsEn", fr: "needsFr", ru: "needsRu", ar: "needsAr" };
  const refUrlKey: Record<TargetLang, "enUrl" | "frUrl" | "ruUrl" | "arUrl"> = { en: "enUrl", fr: "frUrl", ru: "ruUrl", ar: "arUrl" };

  const globalMatchResults = new Map<string, Map<number, BatchMatchResult>>();
  // Task #84: per-tab "why" trace map. Populated by matchTab (title stage) and
  // appended to by the AI stage below; consulted at result-write to attach a
  // per-(row,lang) explanation into the mapping_results.details JSONB.
  const tabMatchTraces = new Map<string, MatchTrace>();
  const tabInventories = new Map<string, { inventories: Record<TargetLang, CrawlInventory | null>; tabPatterns: TabPatterns; usedUrls: Record<TargetLang, Set<string>> }>();
  const tabCoverageStats = new Map<string, Record<TargetLang, { totalInventory: number; mappedSubtrees: number; sparseBefore: number; sparseAfter: number; backfilledUrls: number }>>();
  const tabFenceStats = new Map<string, Record<TargetLang, { titleRejected: number; aiRejected: number; markedRowIndices: Set<number>; nonFenceFailureRowIndices: Set<number> }>>();
  // Task #74: per-tab × per-lang counters for the scope-active relaxations.
  // - titleLoosened: title-stage matches admitted under the lowered floors.
  // - aiSectionSkipped / aiRootSkipped: AI commits where the scope-active
  //   bypass let a section-mismatch / outside-root suggestion through.
  // Surfaced as a single "scoped-loosened" line in the per-tab summary.
  const tabLooseStats = new Map<string, Record<TargetLang, { titleLoosened: number; aiSectionSkipped: number; aiRootSkipped: number }>>();

  function getRowExisting(row: RowData, lang: TargetLang): string {
    switch (lang) { case "en": return row.existingEn; case "fr": return row.existingFr; case "ru": return row.existingRu; case "ar": return row.existingAr; }
  }
  function setRowExisting(row: RowData, lang: TargetLang, val: string) {
    switch (lang) { case "en": row.existingEn = val; break; case "fr": row.existingFr = val; break; case "ru": row.existingRu = val; break; case "ar": row.existingAr = val; break; }
  }
  function getRowNeeds(row: RowData, lang: TargetLang): boolean {
    switch (lang) { case "en": return row.needsEn; case "fr": return row.needsFr; case "ru": return row.needsRu; case "ar": return row.needsAr; }
  }
  function setRowNeeds(row: RowData, lang: TargetLang, val: boolean) {
    switch (lang) { case "en": row.needsEn = val; break; case "fr": row.needsFr = val; break; case "ru": row.needsRu = val; break; case "ar": row.needsAr = val; break; }
  }

  function updateRowsFromResults(allTabDataList: TabData[], results: Map<string, Map<number, BatchMatchResult>>) {
    for (const tabData of allTabDataList) {
      const prevResults = results.get(tabData.sheetName);
      if (!prevResults) continue;
      for (const row of tabData.allRows) {
        const m = prevResults.get(row.rowIndex);
        if (!m) continue;
        for (const l of allLangs) {
          const url = getResultUrl(m, l);
          if (url && getRowNeeds(row, l)) {
            setRowExisting(row, l, url);
            setRowNeeds(row, l, false);
          }
        }
      }
      tabData.tabRefRows = [];
      for (const row of tabData.allRows) {
        const hasAny = allLangs.some(l => !!getRowExisting(row, l));
        if (hasAny) {
          tabData.tabRefRows.push({
            sourceUrl: row.sourceUrl,
            enUrl: row.existingEn || undefined,
            frUrl: row.existingFr || undefined,
            ruUrl: row.existingRu || undefined,
            arUrl: row.existingAr || undefined,
          });
        }
      }
    }
  }

  // Per-job alternate-link cache. Shared across all passes within this job so
  // identical source URLs are fetched at most once even when the multi-pass
  // loop re-enters matchTab for the same tab.
  const alternateLinkCache: AlternateLinkCache = new Map();

  // Job-wide pattern registry: pooled from every tab's confirmed source/target
  // pairs so segment translations and root mappings learned in one tab apply
  // to all other tabs (recursively, after each tab finishes).
  function setRefUrl(ref: TabRefRow, lang: TargetLang, url: string) {
    switch (lang) {
      case "en": ref.enUrl = url; break;
      case "fr": ref.frUrl = url; break;
      case "ru": ref.ruUrl = url; break;
      case "ar": ref.arUrl = url; break;
    }
  }

  const rebuildGlobalRefRows = (): TabRefRow[] => {
    const rows: TabRefRow[] = [];
    for (const td of allTabData) {
      const sheetGlobal = globalMatchResults.get(td.sheetName);
      for (const row of td.allRows) {
        const m = sheetGlobal?.get(row.rowIndex);
        const ref: TabRefRow = { sourceUrl: row.sourceUrl };
        let hasUrl = false;
        for (const l of allLangs) {
          const existing = getRowExisting(row, l);
          const found = m ? getResultUrl(m, l) : null;
          const url = existing || found || undefined;
          if (url) {
            setRefUrl(ref, l, url);
            hasUrl = true;
          }
        }
        if (hasUrl) rows.push(ref);
      }
    }
    return rows;
  };

  const logGlobalRegistrySnapshot = (label: string) => {
    const seedSummary = activeLangs
      .map(l => `${globalPatterns.segmentMap.get(l)?.size || 0} ${l.toUpperCase()}`)
      .join(", ");
    log(`Job ${jobId} [${label}]: global registry has ${globalRefRows.length} confirmed pair(s); segment translations: ${seedSummary}`);
    const lines = summarizeSegmentTranslations(globalPatterns, activeLangs);
    for (const line of lines) log(line);
  };

  // Cross-pass state for Task #64:
  //  - feedbackAnchorsByTab: missing-subtree paths captured by the coverage
  //    diagnostic in the previous pass; the next pass HEAD-probes them and
  //    seeds crawl from any survivors.
  //  - globalMinedSegments: per-language segment translations mined from
  //    inventory by tail-pairing. Re-injected into globalPatterns after every
  //    rebuild from confirmed pairs (which would otherwise drop them).
  const feedbackAnchorsByTab = new Map<string, Record<TargetLang, string[]>>();
  const globalMinedSegments: Record<TargetLang, Map<string, string>> = { en: new Map(), fr: new Map(), ru: new Map(), ar: new Map() };

  function injectMinedIntoGlobal() {
    for (const l of activeLangs) {
      const mined = globalMinedSegments[l];
      if (mined.size === 0) continue;
      let segMap = globalPatterns.segmentMap.get(l);
      if (!segMap) { segMap = new Map(); globalPatterns.segmentMap.set(l, segMap); }
      for (const [k, v] of Array.from(mined.entries())) {
        if (!segMap.has(k)) segMap.set(k, v);
      }
    }
  }

  // Per-tab counters for the new sibling-scope + exclusion summary log.
  // Populated incrementally by detectHeOnlyExclusions() and by the AI
  // commit loop below; surfaced once per tab inside the multipass loop.
  const tabExcludedAutoCount: Record<string, Record<TargetLang, number>> = {};
  const tabSiblingAiAccepted: Record<string, Record<TargetLang, number>> = {};
  function bumpExcludedAuto(tabName: string, lang: TargetLang, n = 1) {
    if (!tabExcludedAutoCount[tabName]) tabExcludedAutoCount[tabName] = { en: 0, fr: 0, ru: 0, ar: 0 };
    tabExcludedAutoCount[tabName][lang] += n;
  }
  function bumpSiblingAi(tabName: string, lang: TargetLang) {
    if (!tabSiblingAiAccepted[tabName]) tabSiblingAiAccepted[tabName] = { en: 0, fr: 0, ru: 0, ar: 0 };
    tabSiblingAiAccepted[tabName][lang] += 1;
  }

  // HE-only auto-detect helper. Runs as a SAFETY NET *before* match
  // commits and again after AI to cover any false positives that slip
  // through. For each (tab, lang) it groups source URLs by their 3-segment
  // HE prefix and marks the prefix excluded only when BOTH negative
  // signals hold:
  //   (A) no reference row under the prefix has a translation for `lang`
  //   (B) no constructed candidate from a sample of ≤5 unmatched rows
  //       under the prefix is present in the inventory
  // When marked excluded-auto, this helper:
  //   * sets needs[lang]=false on every row under the prefix so all
  //     subsequent passes / AI / save block skip it,
  //   * CLEARS any existing match in matchResults / globalMatchResults
  //     for that row+lang (the false positive that motivated this fix),
  //   * records "excluded-auto" in tabData.excludedMethods.
  // Returns the count of newly-excluded row+lang combinations and the
  // count of cleared false-positive matches. Idempotent — re-running on
  // the same tab won't double-count.
  function detectHeOnlyExclusions(
    tabData: TabData,
    inv: { inventories: Record<TargetLang, CrawlInventory | null>; tabPatterns: TabPatterns; usedUrls: Record<TargetLang, Set<string>> },
    extraResults?: Map<number, BatchMatchResult>,
  ): { excluded: number; cleared: number; scannedPrefixes: number } {
    const refUrlByPair: Record<TargetLang, "enUrl" | "frUrl" | "ruUrl" | "arUrl"> = {
      en: "enUrl", fr: "frUrl", ru: "ruUrl", ar: "arUrl",
    };
    const sheetGlobal = globalMatchResults.get(tabData.sheetName);
    let excluded = 0;
    let cleared = 0;
    let scannedPrefixes = 0;
    for (const l of allLangs) {
      if (!targetLangs.includes(l)) continue;
      const inventory = inv.inventories[l];
      if (!inventory) continue;
      const invSet = new Set<string>();
      inventory.urls.forEach(u => invSet.add(u));

      // Group ALL rows by 3-segment HE source prefix — not just unmatched —
      // so a false positive committed in an earlier pass still gets
      // re-evaluated and cleared.
      const groups = new Map<string, RowData[]>();
      for (const row of tabData.allRows) {
        const excl = tabData.excludedMethods?.get(row.rowIndex);
        if (excl?.has(l)) continue;
        const orig = l === "en" ? row.originalEn
                   : l === "fr" ? row.originalFr
                   : l === "ru" ? row.originalRu
                   : row.originalAr;
        if (orig) continue;
        let segs: string[];
        try { segs = new URL(row.sourceUrl).pathname.split("/").filter(Boolean); }
        catch { continue; }
        if (segs.length < 3) continue;
        const prefix = "/" + segs.slice(0, 3).join("/").toLowerCase() + "/";
        let arr = groups.get(prefix);
        if (!arr) { arr = []; groups.set(prefix, arr); }
        arr.push(row);
      }

      for (const [prefix, rows] of Array.from(groups.entries())) {
        scannedPrefixes++;

        // Negative signal A
        let refHit = false;
        for (const ref of tabData.tabRefRows) {
          try {
            const refPath = new URL(ref.sourceUrl).pathname.toLowerCase();
            if (!refPath.startsWith(prefix)) continue;
            if (ref[refUrlByPair[l]]) { refHit = true; break; }
          } catch {}
        }
        if (refHit) continue;

        // Negative signal B (sample up to 5 rows). Two positive checks
        // — either is enough to KEEP the prefix (i.e. NOT exclude):
        //   (B1) an exact constructed candidate is present in the
        //        inventory (filename mappable), OR
        //   (B2) the row has a sibling-scope mapping AND any URL in
        //        the inventory lives under that mapped target directory
        //        (directory-level presence — guards against
        //        over-exclusion when filenames don't transliterate
        //        deterministically but the section IS translated).
        let invHit = false;
        const sample = rows.slice(0, 5);
        for (const r of sample) {
          const cands = constructAllTargetUrls(r.sourceUrl, l, inv.tabPatterns);
          for (const c of cands) {
            if (invSet.has(c)) { invHit = true; break; }
          }
          if (invHit) break;
          const scope = computeSiblingScope(r.sourceUrl, l, inv.tabPatterns);
          if (scope) {
            const tgtPrefix = ("/" + scope.mappedTgtDir.join("/") + "/").toLowerCase();
            for (const u of Array.from(invSet)) {
              try {
                if (new URL(u).pathname.toLowerCase().startsWith(tgtPrefix)) { invHit = true; break; }
              } catch {}
            }
            if (invHit) break;
          }
        }
        if (invHit) continue;

        // Both signals negative → HE-only prefix for this language.
        if (!tabData.excludedMethods) tabData.excludedMethods = new Map();
        for (const r of rows) {
          let perRow = tabData.excludedMethods.get(r.rowIndex);
          if (!perRow) { perRow = new Map(); tabData.excludedMethods.set(r.rowIndex, perRow); }
          if (!perRow.has(l)) {
            perRow.set(l, "excluded-auto");
            excluded++;
            bumpExcludedAuto(tabData.sheetName, l, 1);
          }
          // Drop needs[lang] so subsequent passes skip this row entirely.
          switch (l) {
            case "en": r.needsEn = false; break;
            case "fr": r.needsFr = false; break;
            case "ru": r.needsRu = false; break;
            case "ar": r.needsAr = false; break;
          }
          // Clear any false-positive match already committed for this
          // row+lang in either the in-flight extraResults map (current
          // pass's matchResults, before commit) or the globalMatchResults.
          if (extraResults) {
            const m = extraResults.get(r.rowIndex);
            const exUrl = m ? getResultUrl(m, l) : null;
            if (m && exUrl) {
              clearResultMatch(m, l);
              // matchTab populates usedUrls inline as matches are made,
              // so by the time we see this in matchResults the URL is
              // already claimed. Release it so other rows in this tab
              // can still claim it in the same pass.
              inv.usedUrls[l].delete(exUrl);
              cleared++;
            }
          }
          if (sheetGlobal) {
            const gm = sheetGlobal.get(r.rowIndex);
            if (gm && getResultUrl(gm, l)) {
              const url = getResultUrl(gm, l)!;
              clearResultMatch(gm, l);
              cleared++;
              // Free the URL so other rows can claim it.
              inv.usedUrls[l].delete(url);
            }
          }
        }
        log(`  Auto-exclude (${l.toUpperCase()}) prefix="${prefix}" rows=${rows.length} (no ref translation, no inventory hit)`);
      }
    }
    return { excluded, cleared, scannedPrefixes };
  }

  let globalRefRows = rebuildGlobalRefRows();
  let globalPatterns = learnTabPatterns(globalRefRows, activeLangs, { silent: true, label: "[global]" });
  logGlobalRegistrySnapshot("seed");

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (control.cancel) break;

    const passStartTime = Date.now();
    let passNewMatches = 0;
    let passNewMined = 0;
    let passNewFeedbackAnchors = 0;

    if (pass > 1) {
      log(`\n========== PASS ${pass} ==========`);
      log(`Re-learning patterns from updated reference rows...`);
      updateRowsFromResults(allTabData, globalMatchResults);
      globalRefRows = rebuildGlobalRefRows();
      globalPatterns = learnTabPatterns(globalRefRows, activeLangs, { silent: true, label: "[global]" });
      injectMinedIntoGlobal();
    }
    logGlobalRegistrySnapshot(`pass ${pass} start`);

    for (const tabData of allTabData) {
      if (control.cancel) break;

      const needsMatching = tabData.allRows.filter((r) => r.needsEn || r.needsFr || r.needsRu || r.needsAr);
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

      const incomingFeedback = feedbackAnchorsByTab.get(tabData.sheetName);
      const { matchResults, inventories: tabInv, tabPatterns, usedUrls: tabUsed, newFeedbackAnchors, minedSegments, coverageStats, fenceStats, titleLoosenedAccepted, matchTrace } = await matchTab(tabData, crawlCache, control, activeLangs, effectiveCap, seedMap.get(tabData.sheetName), alternateLinkCache, globalPatterns, incomingFeedback);
      // Task #84: merge per-pass trace into the per-tab accumulator so the AI
      // stage and result-write can see entries from earlier passes too.
      const existingTrace = tabMatchTraces.get(tabData.sheetName);
      if (existingTrace) {
        for (const [rowIdx, langMap] of Array.from(matchTrace.entries())) {
          const existingRow = existingTrace.get(rowIdx) || {};
          for (const [l, entry] of Object.entries(langMap)) {
            if (entry) existingRow[l as TargetLang] = entry;
          }
          existingTrace.set(rowIdx, existingRow);
        }
      } else {
        tabMatchTraces.set(tabData.sheetName, matchTrace);
      }
      tabInventories.set(tabData.sheetName, { inventories: tabInv, tabPatterns, usedUrls: tabUsed });
      tabCoverageStats.set(tabData.sheetName, coverageStats);
      // Sibling-scope fence accumulator across passes within this tab. Each
      // pass calls matchTab once; sum so the per-tab summary log reflects the
      // total commit-time rejections caused by the fence over the whole job.
      const prevFence = tabFenceStats.get(tabData.sheetName);
      if (prevFence) {
        for (const l of allLangs) {
          prevFence[l].titleRejected += fenceStats[l].titleRejected;
          prevFence[l].aiRejected += fenceStats[l].aiRejected;
          for (const idx of Array.from(fenceStats[l].markedRowIndices)) {
            prevFence[l].markedRowIndices.add(idx);
          }
          for (const idx of Array.from(fenceStats[l].nonFenceFailureRowIndices)) {
            prevFence[l].nonFenceFailureRowIndices.add(idx);
          }
        }
      } else {
        tabFenceStats.set(tabData.sheetName, fenceStats);
      }
      // Task #74: accumulate title-stage scope-loosened admissions across
      // passes for this tab. AI-side scope skips are folded in later, after
      // the AI matcher returns.
      const prevLoose = tabLooseStats.get(tabData.sheetName);
      if (prevLoose) {
        for (const l of allLangs) prevLoose[l].titleLoosened += titleLoosenedAccepted[l];
      } else {
        tabLooseStats.set(tabData.sheetName, {
          en: { titleLoosened: titleLoosenedAccepted.en, aiSectionSkipped: 0, aiRootSkipped: 0 },
          fr: { titleLoosened: titleLoosenedAccepted.fr, aiSectionSkipped: 0, aiRootSkipped: 0 },
          ru: { titleLoosened: titleLoosenedAccepted.ru, aiSectionSkipped: 0, aiRootSkipped: 0 },
          ar: { titleLoosened: titleLoosenedAccepted.ar, aiSectionSkipped: 0, aiRootSkipped: 0 },
        });
      }

      // HE-only auto-detect: applied IMMEDIATELY after the per-tab inventory
      // is built and BEFORE this pass's matchResults are merged into the
      // global state. Any false-positive matches inside matchResults that
      // fall under a freshly-detected HE-only prefix are cleared in-place,
      // and rows under the prefix have their needs[lang] flipped off so all
      // later passes / the AI stage / the save block skip them.
      const autoDet = detectHeOnlyExclusions(
        tabData,
        { inventories: tabInv, tabPatterns, usedUrls: tabUsed },
        matchResults,
      );
      if (autoDet.excluded > 0 || autoDet.cleared > 0) {
        log(`  HE-only auto-detect (pre-commit, "${tabData.sheetName}"): excluded ${autoDet.excluded} row+lang, cleared ${autoDet.cleared} false-positive match(es) across ${autoDet.scannedPrefixes} prefix×lang group(s)`);
      }

      // Track new feedback anchors / mined segments so the multi-pass loop
      // continues even when this pass produced 0 new matches but DID surface
      // new crawl seeds or new segment translations to use next pass.
      const prevFeedback = feedbackAnchorsByTab.get(tabData.sheetName) || { en: [], fr: [], ru: [], ar: [] };
      const mergedFeedback: Record<TargetLang, string[]> = { en: [], fr: [], ru: [], ar: [] };
      for (const l of activeLangs) {
        const seen = new Set<string>(prevFeedback[l]);
        const merged = prevFeedback[l].slice();
        for (const p of newFeedbackAnchors[l]) {
          if (!seen.has(p)) { seen.add(p); merged.push(p); passNewFeedbackAnchors++; }
        }
        mergedFeedback[l] = merged;
      }
      feedbackAnchorsByTab.set(tabData.sheetName, mergedFeedback);

      for (const l of activeLangs) {
        for (const [k, v] of Array.from(minedSegments[l].entries())) {
          if (!globalMinedSegments[l].has(k)) {
            globalMinedSegments[l].set(k, v);
            passNewMined++;
          }
        }
      }

      if (!globalMatchResults.has(tabData.sheetName)) {
        globalMatchResults.set(tabData.sheetName, new Map());
      }
      const sheetGlobal = globalMatchResults.get(tabData.sheetName)!;

      let tabNewMatches = 0;
      for (const [rowIndex, result] of Array.from(matchResults.entries())) {
        const existing = sheetGlobal.get(rowIndex);
        if (!existing) {
          const hasAny = allLangs.some(l => getResultUrl(result, l) !== null);
          if (hasAny) {
            sheetGlobal.set(rowIndex, result);
            tabNewMatches++;
          }
        } else {
          for (const l of allLangs) {
            const url = getResultUrl(result, l);
            if (url && !getResultUrl(existing, l)) {
              // Preserve scoped/crossScript flags so they survive the multi-pass
              // merge into the durable per-tab result map.
              setResultMatch(existing, l, url, getResultConf(result, l) || 0, getResultMethod(result, l) || "", getResultFlags(result, l) ?? undefined);
              tabNewMatches++;
            }
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

      if (tabNewMatches > 0) {
        const prevSize = globalRefRows.length;
        globalRefRows = rebuildGlobalRefRows();
        const prevSegs: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
        for (const l of activeLangs) prevSegs[l] = globalPatterns.segmentMap.get(l)?.size || 0;
        globalPatterns = learnTabPatterns(globalRefRows, activeLangs, { silent: true, label: "[global]" });
        injectMinedIntoGlobal();
        const segDelta = activeLangs
          .map(l => ({ l, d: (globalPatterns.segmentMap.get(l)?.size || 0) - prevSegs[l] }))
          .filter(x => x.d > 0)
          .map(x => `+${x.d} ${x.l.toUpperCase()}`)
          .join(", ");
        log(`Global registry refreshed: ${globalRefRows.length} pairs (was ${prevSize})${segDelta ? `, segment translations ${segDelta}` : ""}`);
      }
    }

    const passTime = ((Date.now() - passStartTime) / 1000).toFixed(1);
    log(`\nPass ${pass} completed in ${passTime}s: ${passNewMatches} new matches, ${passNewMined} mined segment(s), ${passNewFeedbackAnchors} feedback anchor(s)`);

    const shouldContinue = passNewMatches > 0 || passNewMined > 0 || passNewFeedbackAnchors > 0;
    if (pass > 1 && !shouldContinue) {
      log(`Pass ${pass} produced no new matches, mined segments, or feedback anchors — stopping multi-pass.`);
      break;
    }

    if (pass < MAX_PASSES && passNewMatches > 0) {
      updateRowsFromResults(allTabData, globalMatchResults);
    }
  }

  if (!control.cancel) {
    await storage.updateJob(jobId, { currentStep: "ai-matching" });

    const pooledInventory: Record<TargetLang, CrawlInventory | null> = { en: null, fr: null, ru: null, ar: null };
    for (const l of activeLangs) {
      const all = Array.from(tabInventories.values()).map(t => t.inventories[l]);
      pooledInventory[l] = mergeInventories(all);
    }
    const pooledSummary = activeLangs.map(l => `${pooledInventory[l]?.urls.size ?? 0} ${l.toUpperCase()}`).join(", ");
    log(`\nPooled crawl inventory for AI matching: ${pooledSummary}`);

    const langRootCrawled: Record<TargetLang, boolean> = { en: false, fr: false, ru: false, ar: false };
    for (const l of activeLangs) {
      if (control.cancel) break;
      if (pooledInventory[l] && pooledInventory[l]!.urls.size > 0) continue;
      if (langRootCrawled[l]) continue;
      let chosenScope: string[] = [];
      let chosenOrigin = "";
      for (const t of Array.from(tabInventories.values())) {
        const r = langRoot(t.tabPatterns, l);
        if (r.length > 0) {
          chosenScope = r;
          for (const td of allTabData) {
            const ref = td.tabRefRows[0];
            const url = ref?.[refUrlKey[l]];
            if (url) {
              try { chosenOrigin = new URL(url).origin; break; } catch {}
            }
          }
          if (!chosenOrigin) {
            for (const td of allTabData) {
              const row = td.allRows.find(r => r.sourceUrl);
              if (row) {
                try { chosenOrigin = new URL(row.sourceUrl).origin; break; } catch {}
              }
            }
          }
          break;
        }
      }
      if (chosenScope.length === 0 || !chosenOrigin) continue;
      const fallbackKey = `fallback:${l}:${chosenScope.join("/")}`;
      if (crawlCache.has(fallbackKey)) {
        pooledInventory[l] = crawlCache.get(fallbackKey)!;
        log(`  Language-root fallback ${l.toUpperCase()} cached: ${pooledInventory[l]!.urls.size} URLs`);
        langRootCrawled[l] = true;
        continue;
      }
      const FALLBACK_MAX_PAGES = Math.max(1000, Math.min(effectiveCap, HARD_CAP));
      log(`  Language-root fallback crawl for ${l.toUpperCase()}: /${chosenScope.join("/")}/  (no per-tab inventory available, cap ${FALLBACK_MAX_PAGES} pages)`);
      try {
        const inv = await crawlDirectory(
          chosenOrigin,
          chosenScope,
          (c, q) => { if (c % 100 === 0) log(`    ${l.toUpperCase()} fallback crawl: ${c} pages, ${q} queued`); },
          undefined,
          control.signal,
          FALLBACK_MAX_PAGES,
        );
        pooledInventory[l] = inv;
        crawlCache.set(fallbackKey, inv);
        log(`  Language-root fallback ${l.toUpperCase()} complete: ${inv.urls.size} URLs`);
      } catch (e) {
        log(`  Language-root fallback ${l.toUpperCase()} failed: ${(e as Error).message}`);
      }
      langRootCrawled[l] = true;
    }

    for (const tabData of allTabData) {
      if (control.cancel) break;

      const sheetGlobal = globalMatchResults.get(tabData.sheetName);
      const inv = tabInventories.get(tabData.sheetName);
      if (!sheetGlobal || !inv) continue;

      // Task #89 — trace bookkeeping must straddle the filter so rows
      // dropped at the AI gate get a per-(row,lang) trace entry instead
      // of leaving the title-stage's "no-candidates"/"below-threshold"
      // verdict as the silent last word. Hoisting the tab trace map up
      // here lets the filter pass write `ai-no-title` directly.
      const tabTraceForAi: MatchTrace = tabMatchTraces.get(tabData.sheetName) ?? (() => {
        const t: MatchTrace = new Map();
        tabMatchTraces.set(tabData.sheetName, t);
        return t;
      })();

      const unmatchedForAi: Array<{ rowIndex: number; title: string; sourceUrl: string; needs: Record<TargetLang, boolean> }> = [];
      for (const row of tabData.allRows) {
        const m = sheetGlobal.get(row.rowIndex);
        const needs: Record<TargetLang, boolean> = { en: false, fr: false, ru: false, ar: false };
        let hasAnyNeed = false;
        // Track langs the user originally wanted (per the workbook header)
        // separately from `needs` (which excludes langs already filled by
        // earlier stages). The two sets diverge for "no-needs" rows where
        // every wanted lang has already been satisfied — we still want a
        // trace entry for those wanted langs so the AI gate is visible.
        const wantsByLang: Record<TargetLang, boolean> = { en: false, fr: false, ru: false, ar: false };
        for (const l of allLangs) {
          wantsByLang[l] = !!row[needsKey[l]];
          needs[l] = !!(row[needsKey[l]] && (!m || !getResultUrl(m, l)));
          if (needs[l]) hasAnyNeed = true;
        }
        if (!hasAnyNeed) {
          // Task #89 — record `ai-no-needs` only when no prior stage has
          // already written a trace for this (row, lang). That preserves
          // the more authoritative `matched` / `known-url` / etc. outcomes
          // from earlier stages while still filling genuine gaps.
          const existingForRow = tabTraceForAi.get(row.rowIndex);
          for (const l of allLangs) {
            if (wantsByLang[l] && !(existingForRow && existingForRow[l])) {
              setTrace(tabTraceForAi, row.rowIndex, l, { stage: "ai", outcome: "ai-no-needs" });
            }
          }
          continue;
        }
        if (!row.title) {
          for (const l of allLangs) {
            if (needs[l]) {
              setTrace(tabTraceForAi, row.rowIndex, l, { stage: "ai", outcome: "ai-no-title" });
            }
          }
          continue;
        }
        unmatchedForAi.push({ rowIndex: row.rowIndex, title: row.title, sourceUrl: row.sourceUrl, needs });
      }

      if (unmatchedForAi.length === 0) continue;

      log(`\n=== AI Matching for tab: "${tabData.sheetName}" (${unmatchedForAi.length} unmatched) ===`);
      await storage.updateJob(jobId, { currentStep: `ai:${tabData.sheetName}` });

      const knownUrlSets: Record<TargetLang, Set<string>> = { en: new Set(), fr: new Set(), ru: new Set(), ar: new Set() };
      for (const ref of tabData.tabRefRows) {
        for (const l of allLangs) {
          const url = ref[refUrlKey[l]];
          if (url) knownUrlSets[l].add(url);
        }
      }
      for (const [, mr] of Array.from(sheetGlobal.entries())) {
        for (const l of allLangs) {
          const url = getResultUrl(mr, l);
          if (url) knownUrlSets[l].add(url);
        }
      }

      const matchedExamples = tabData.tabRefRows.slice(0, 10);

      const allTranslations: Record<TargetLang, Map<string, string>> = { en: new Map(), fr: new Map(), ru: new Map(), ar: new Map() };
      for (const l of activeLangs) {
        if (control.cancel) break;
        const titles = unmatchedForAi.filter(r => r.needs[l]).map(r => r.title).filter(Boolean);
        if (titles.length > 0) {
          allTranslations[l] = await batchTranslate(titles, l, storage, control.signal);
        }
      }

      if (control.cancel) continue;

      const effectiveInventories: Record<TargetLang, CrawlInventory | null> = { en: null, fr: null, ru: null, ar: null };
      for (const l of allLangs) {
        const tabInv = inv.inventories[l];
        const pooled = pooledInventory[l];
        if (tabInv && pooled && tabInv !== pooled) {
          effectiveInventories[l] = mergeInventories([tabInv, pooled]);
        } else {
          effectiveInventories[l] = tabInv ?? pooled ?? null;
        }
      }

      // Per-tab cross-script detection mirrors the title-stage call so AI
      // matches can be tagged with the same flag in mapping_results.details.
      const aiCrossScriptLangs = detectCrossScriptLangs(tabData.tabRefRows, allLangs);

      // tabTraceForAi was hoisted above (Task #89) so the AI-gate filter
      // can record `ai-no-title` for rows it drops; reuse the same map here.
      const aiOutput = await aiMatchUnmatched(
        unmatchedForAi,
        effectiveInventories,
        inv.tabPatterns,
        matchedExamples,
        allTranslations,
        knownUrlSets,
        control.signal,
        aiCrossScriptLangs,
        tabTraceForAi,
      );
      const aiMatches = aiOutput.matches;
      // Fold the AI matcher's sibling-scope fence rejections into this tab's
      // running totals so the per-tab summary log captures them alongside the
      // title-stage fence numbers from matchTab.
      const aiFenceForTab = tabFenceStats.get(tabData.sheetName);
      if (aiFenceForTab) {
        for (const l of allLangs) {
          aiFenceForTab[l].aiRejected += aiOutput.siblingFence[l].rejected;
          for (const idx of Array.from(aiOutput.siblingFence[l].markedRowIndices)) {
            aiFenceForTab[l].markedRowIndices.add(idx);
          }
          for (const idx of Array.from(aiOutput.siblingFence[l].nonFenceFailureRowIndices)) {
            aiFenceForTab[l].nonFenceFailureRowIndices.add(idx);
          }
        }
      } else {
        tabFenceStats.set(tabData.sheetName, {
          en: { titleRejected: 0, aiRejected: aiOutput.siblingFence.en.rejected, markedRowIndices: new Set(aiOutput.siblingFence.en.markedRowIndices), nonFenceFailureRowIndices: new Set(aiOutput.siblingFence.en.nonFenceFailureRowIndices) },
          fr: { titleRejected: 0, aiRejected: aiOutput.siblingFence.fr.rejected, markedRowIndices: new Set(aiOutput.siblingFence.fr.markedRowIndices), nonFenceFailureRowIndices: new Set(aiOutput.siblingFence.fr.nonFenceFailureRowIndices) },
          ru: { titleRejected: 0, aiRejected: aiOutput.siblingFence.ru.rejected, markedRowIndices: new Set(aiOutput.siblingFence.ru.markedRowIndices), nonFenceFailureRowIndices: new Set(aiOutput.siblingFence.ru.nonFenceFailureRowIndices) },
          ar: { titleRejected: 0, aiRejected: aiOutput.siblingFence.ar.rejected, markedRowIndices: new Set(aiOutput.siblingFence.ar.markedRowIndices), nonFenceFailureRowIndices: new Set(aiOutput.siblingFence.ar.nonFenceFailureRowIndices) },
        });
      }
      // Task #74: fold AI-stage scope-skip counters into this tab's
      // loose-stats accumulator alongside the title-stage counts. Initialize
      // the entry if matchTab didn't already (e.g. no title-stage call ran).
      const aiLooseForTab = tabLooseStats.get(tabData.sheetName);
      if (aiLooseForTab) {
        for (const l of allLangs) {
          aiLooseForTab[l].aiSectionSkipped += aiOutput.scopeSkipped[l].sectionSkipped;
          aiLooseForTab[l].aiRootSkipped += aiOutput.scopeSkipped[l].outsideRootSkipped;
        }
      } else {
        tabLooseStats.set(tabData.sheetName, {
          en: { titleLoosened: 0, aiSectionSkipped: aiOutput.scopeSkipped.en.sectionSkipped, aiRootSkipped: aiOutput.scopeSkipped.en.outsideRootSkipped },
          fr: { titleLoosened: 0, aiSectionSkipped: aiOutput.scopeSkipped.fr.sectionSkipped, aiRootSkipped: aiOutput.scopeSkipped.fr.outsideRootSkipped },
          ru: { titleLoosened: 0, aiSectionSkipped: aiOutput.scopeSkipped.ru.sectionSkipped, aiRootSkipped: aiOutput.scopeSkipped.ru.outsideRootSkipped },
          ar: { titleLoosened: 0, aiSectionSkipped: aiOutput.scopeSkipped.ar.sectionSkipped, aiRootSkipped: aiOutput.scopeSkipped.ar.outsideRootSkipped },
        });
      }

      if (aiMatches.size > 0) {
        // AI picks come from the crawled inventory, which is already proof of
        // existence — re-running HEAD here previously rejected every match on
        // sites where HEAD is unreliable (e.g. BTL returns 4xx for valid
        // pages). Trust inventory membership; the AI step itself enforces it.
        // Depth validation is also a frequent false-positive for RU/AR where
        // the source/target tree shapes diverge, so it is downgraded to a
        // warning for those languages.
        const rowSourceMap = new Map<number, string>();
        for (const r of unmatchedForAi) {
          rowSourceMap.set(r.rowIndex, r.sourceUrl);
        }

        let aiAccepted = 0;
        let aiDepthRejected = 0;
        let aiDepthWarned = 0;

        for (const [rowIndex, aiResult] of Array.from(aiMatches.entries())) {
          const srcUrl = rowSourceMap.get(rowIndex) || "";

          for (const l of allLangs) {
            const url = getResultUrl(aiResult, l);
            const sr = langSrcRoot(inv.tabPatterns, l);
            if (url && srcUrl && sr.length > 0) {
              if (!validateDepthMatch(srcUrl, url, sr, langRoot(inv.tabPatterns, l))) {
                if (l === "ru" || l === "ar") {
                  log(`    AI DEPTH WARN (${l.toUpperCase()}, accepting): ${url}`);
                  aiDepthWarned++;
                } else {
                  log(`    AI DEPTH REJECTED: ${l.toUpperCase()} ${url}`);
                  clearResultMatch(aiResult, l);
                  aiDepthRejected++;
                }
              }
            }
          }

          const hasAny = allLangs.some(l => getResultUrl(aiResult, l) !== null);
          if (hasAny) {
            let existing = sheetGlobal.get(rowIndex);
            if (!existing) {
              existing = emptyBatchResult();
              sheetGlobal.set(rowIndex, existing);
            }
            for (const l of allLangs) {
              const url = getResultUrl(aiResult, l);
              if (!url) continue;
              if (!getResultUrl(existing, l) && !inv.usedUrls[l].has(url)) {
                const method = getResultMethod(aiResult, l) || "";
                // Preserve scoped/crossScript flags captured by the AI matcher.
                setResultMatch(existing, l, url, getResultConf(aiResult, l) || 0, method, getResultFlags(aiResult, l) ?? undefined);
                inv.usedUrls[l].add(url);
                aiAccepted++;
                // Per-tab sibling-AI accept telemetry: when this row's source
                // URL is covered by a per-pair sibling scope and the chosen
                // AI URL is under that scoped target subtree, count it. This
                // is what closes the loop on the sibling-scope "soft hint"
                // we plant in aiMatchUnmatched.
                const scope = computeSiblingScope(srcUrl, l, inv.tabPatterns);
                if (scope) {
                  const tgtPrefix = ("/" + scope.mappedTgtDir.join("/") + "/").toLowerCase();
                  try {
                    if (new URL(url).pathname.toLowerCase().startsWith(tgtPrefix)) {
                      bumpSiblingAi(tabData.sheetName, l);
                    }
                  } catch {}
                }
              }
            }
          }
        }

        matchedCount += aiAccepted;
        log(`  AI results: ${aiAccepted} accepted, ${aiDepthRejected} depth-rejected${aiDepthWarned > 0 ? `, ${aiDepthWarned} depth-warned (RU/AR soft gate)` : ''}`);
        await storage.updateJob(jobId, { matchedUrls: matchedCount });

        // Re-run HE-only auto-detect after AI commits to nuke any AI false
        // positives that fell under a freshly-detected HE-only prefix
        // (e.g. AI obeyed a soft section hint into a subtree that the
        // pattern/title passes had no inventory hits for).
        const postAiDet = detectHeOnlyExclusions(tabData, inv);
        if (postAiDet.excluded > 0 || postAiDet.cleared > 0) {
          log(`  HE-only auto-detect (post-AI, "${tabData.sheetName}"): excluded ${postAiDet.excluded} row+lang, cleared ${postAiDet.cleared} false-positive AI match(es)`);
          if (postAiDet.cleared > 0) matchedCount = Math.max(0, matchedCount - postAiDet.cleared);
        }
      }
    }
  }

  // Per-tab final summary: sibling-scope AI accepts + exclusion counts.
  // Title sibling-scope counts are surfaced inside scraper.ts's
  // titleMatchUnmatched. We aggregate the AI side and the two exclusion
  // methods here, where we know per-tab boundaries.
  for (const tabData of allTabData) {
    const aiCounts = tabSiblingAiAccepted[tabData.sheetName];
    const autoCounts = tabExcludedAutoCount[tabData.sheetName];
    let configCount = 0;
    if (tabData.excludedMethods) {
      for (const perRow of Array.from(tabData.excludedMethods.values())) {
        for (const m of Array.from(perRow.values())) if (m === "excluded-config") configCount++;
      }
    }
    const aiSummary = aiCounts
      ? allLangs.filter(l => aiCounts[l] > 0).map(l => `${l.toUpperCase()}=${aiCounts[l]}`).join(", ")
      : "";
    const autoSummary = autoCounts
      ? allLangs.filter(l => autoCounts[l] > 0).map(l => `${l.toUpperCase()}=${autoCounts[l]}`).join(", ")
      : "";
    if (aiSummary || autoSummary || configCount > 0) {
      log(`Tab "${tabData.sheetName}" sibling/excludes summary: sibling-AI accepted{${aiSummary || "none"}}, excluded-config=${configCount}, excluded-auto{${autoSummary || "none"}}`);
    }

    // Coverage telemetry: per-language inventory size and number of mapped
    // subtrees still below the threshold AFTER the backfill pass. A non-zero
    // sparse-after count means the matcher is missing target-language pages
    // that the workbook's reference rows say should exist.
    const cov = tabCoverageStats.get(tabData.sheetName);
    if (cov) {
      // Emit one deterministic line per active language so a missing entry
      // is unambiguously a bug rather than a "skipped because zero" choice.
      const invLine = activeLangs
        .map(l => `${l.toUpperCase()}=${cov[l].totalInventory}`)
        .join(", ");
      const sparseLine = activeLangs
        .map(l => `${l.toUpperCase()}: ${cov[l].sparseAfter}/${cov[l].mappedSubtrees} sparse (backfill +${cov[l].backfilledUrls})`)
        .join("; ");
      if (invLine) {
        log(`Tab "${tabData.sheetName}" inventory totals: ${invLine}`);
      }
      if (sparseLine) {
        log(`Tab "${tabData.sheetName}" mapped-subtree coverage: ${sparseLine}`);
      }
    }

    // Sibling-scope fence telemetry (Task #70). Reports candidates that the
    // matcher rejected at commit time because they fell outside the per-pair
    // mappedTgtDir for a row whose source row had a confirmed sibling scope.
    // A blank result is preferred over a wrong-section URL, so non-zero
    // numbers here are expected and healthy — they show the fence working.
    const fence = tabFenceStats.get(tabData.sheetName);
    if (fence) {
      const titleLine = activeLangs
        .filter(l => fence[l].titleRejected > 0)
        .map(l => `${l.toUpperCase()}=${fence[l].titleRejected}`)
        .join(", ");
      const aiLine = activeLangs
        .filter(l => fence[l].aiRejected > 0)
        .map(l => `${l.toUpperCase()}=${fence[l].aiRejected}`)
        .join(", ");
      // Row-level fence-only-blocked counter (Task #70 acceptance criterion).
      // Strict definition: a row counts iff (a) the sibling-scope fence
      // rejected at least one candidate for that row in this tab × language
      // (rowIndex ∈ markedRowIndices), AND (b) NO non-fence commit-time
      // failure was recorded for the same row × language anywhere across
      // the pattern, alt-link, HEAD, title, or AI stages (rowIndex ∉
      // nonFenceFailureRowIndices), AND (c) the row's final committed
      // result has no URL for that language. This is the exact "fence
      // rejected the only commit-eligible candidate" measurement: any
      // other commit failure for the same row × language disqualifies it,
      // so the count is neither inflated by orthogonal failures nor
      // deflated by partial fence interactions.
      const finalResults = globalMatchResults.get(tabData.sheetName);
      const rowsFenceOnlyBlocked: Record<TargetLang, number> = { en: 0, fr: 0, ru: 0, ar: 0 };
      if (finalResults) {
        for (const l of activeLangs) {
          for (const idx of Array.from(fence[l].markedRowIndices)) {
            if (fence[l].nonFenceFailureRowIndices.has(idx)) continue;
            const r = finalResults.get(idx);
            if (!r || !getResultUrl(r, l)) rowsFenceOnlyBlocked[l]++;
          }
        }
      }
      const rowsLine = activeLangs
        .filter(l => rowsFenceOnlyBlocked[l] > 0)
        .map(l => `${l.toUpperCase()}=${rowsFenceOnlyBlocked[l]}`)
        .join(", ");
      if (titleLine || aiLine || rowsLine) {
        log(`Tab "${tabData.sheetName}" sibling-scope fence: title-stage{${titleLine || "none"}}, AI-stage{${aiLine || "none"}}, rows-blocked-by-fence-only{${rowsLine || "none"}}`);
      }
    }

    // Task #74: per-tab "scoped-loosened" summary line. Reports
    //   * title{...}: borderline title-stage matches admitted under the
    //     scope-relaxed cheap/semantic/paired/single-lang floors;
    //   * ai-section-skipped{...}: AI commits where the section-context
    //     gate was bypassed because the row's sibling-scope fence is active;
    //   * ai-root-skipped{...}: AI commits where the outside-root gate was
    //     bypassed for the same reason.
    // All three are silent (omitted) when zero, mirroring the fence line
    // above, so unscoped runs see no extra log noise.
    const loose = tabLooseStats.get(tabData.sheetName);
    if (loose) {
      const titleLine = activeLangs
        .filter(l => loose[l].titleLoosened > 0)
        .map(l => `${l.toUpperCase()}=${loose[l].titleLoosened}`)
        .join(", ");
      const aiSecLine = activeLangs
        .filter(l => loose[l].aiSectionSkipped > 0)
        .map(l => `${l.toUpperCase()}=${loose[l].aiSectionSkipped}`)
        .join(", ");
      const aiRootLine = activeLangs
        .filter(l => loose[l].aiRootSkipped > 0)
        .map(l => `${l.toUpperCase()}=${loose[l].aiRootSkipped}`)
        .join(", ");
      if (titleLine || aiSecLine || aiRootLine) {
        log(`Tab "${tabData.sheetName}" scoped-loosened: title{${titleLine || "none"}}, ai-section-skipped{${aiSecLine || "none"}}, ai-root-skipped{${aiRootLine || "none"}}`);
      }
    }
  }

  await storage.updateJob(jobId, { currentStep: control.cancel ? "saving-partial" : "saving" });
  if (control.cancel) {
    log(`Job ${jobId} cancelled — saving partial results from passes already completed.`);
  }

  await storage.deleteResultsByJob(jobId);

  let finalMatchedCount = 0;

  for (const tabData of allTabData) {
    const sheetGlobal = globalMatchResults.get(tabData.sheetName) || new Map();
    // Task #84: per-tab "why" trace assembled by the title and AI matchers.
    // Read at result-write to attach a per-(row,lang) explanation into the
    // mapping_results.details JSONB. May be undefined if no matching pass ran
    // for this tab (e.g. tab fully prefilled).
    const sheetTrace = tabMatchTraces.get(tabData.sheetName);
    const resultBatch: any[] = [];

    for (const row of tabData.allRows) {
      const match = sheetGlobal.get(row.rowIndex);
      let enUrl: string | null = row.originalEn || null;
      let frUrl: string | null = row.originalFr || null;
      let ruUrl: string | null = row.originalRu || null;
      let arUrl: string | null = row.originalAr || null;
      let confidenceEn: number | null = null;
      let confidenceFr: number | null = null;
      let confidenceRu: number | null = null;
      let confidenceAr: number | null = null;
      let matchMethodEn: string | null = row.originalEn ? "existing" : null;
      let matchMethodFr: string | null = row.originalFr ? "existing" : null;
      let matchMethodRu: string | null = row.originalRu ? "existing" : null;
      let matchMethodAr: string | null = row.originalAr ? "existing" : null;

      if (match) {
        if (match.enUrl && !row.originalEn) {
          enUrl = match.enUrl; confidenceEn = match.confidenceEn; matchMethodEn = match.matchMethodEn;
        }
        if (match.frUrl && !row.originalFr) {
          frUrl = match.frUrl; confidenceFr = match.confidenceFr; matchMethodFr = match.matchMethodFr;
        }
        if (match.ruUrl && !row.originalRu) {
          ruUrl = match.ruUrl; confidenceRu = match.confidenceRu; matchMethodRu = match.matchMethodRu;
        }
        if (match.arUrl && !row.originalAr) {
          arUrl = match.arUrl; confidenceAr = match.confidenceAr; matchMethodAr = match.matchMethodAr;
        }
      }

      // Exclusion records (Excludes sheet + auto-detect): when a row+lang
      // was deliberately skipped from matching, surface the method so the
      // user can audit. URL stays null. Existing matches and pre-existing
      // values take precedence — exclusions only fill empty slots.
      const excl = tabData.excludedMethods?.get(row.rowIndex);
      if (excl) {
        if (excl.has("en") && !enUrl && !matchMethodEn) matchMethodEn = excl.get("en")!;
        if (excl.has("fr") && !frUrl && !matchMethodFr) matchMethodFr = excl.get("fr")!;
        if (excl.has("ru") && !ruUrl && !matchMethodRu) matchMethodRu = excl.get("ru")!;
        if (excl.has("ar") && !arUrl && !matchMethodAr) matchMethodAr = excl.get("ar")!;
      }

      // Task #88: count only matches the run discovered. Rows whose only
      // populated URLs came from the upload (`match_method_xx === 'existing'`)
      // are surfaced separately via `prefilledUrls` and must NOT inflate the
      // "Matches found" tally on the dashboard.
      const rowFinalMethods: Record<TargetLang, string | null> = { en: matchMethodEn, fr: matchMethodFr, ru: matchMethodRu, ar: matchMethodAr };
      const rowFinalUrls: Record<TargetLang, string | null> = { en: enUrl, fr: frUrl, ru: ruUrl, ar: arUrl };
      const rowHasNewMatch = activeLangsForCount.some(l =>
        !!rowFinalUrls[l] && rowFinalMethods[l] !== "existing"
      );
      if (rowHasNewMatch) finalMatchedCount++;

      // Per-language diagnostic block stored in mapping_results.details JSONB.
      // Captures the matcher stage (derived from the method string), a short
      // reason string, and the per-(row,lang) scoped/crossScript flags
      // recorded at match time. Used for post-hoc auditing only — the
      // user-facing Excel export is unchanged.
      const stageOf = (method: string | null): string | null => {
        if (!method) return null;
        if (method === "existing") return "existing";
        if (method.startsWith("excluded")) return "excluded";
        if (method === "ai-match") return "ai";
        if (method.startsWith("title")) return "title";
        if (method.includes("tail") || method.startsWith("crawl") || method.startsWith("inventory")) return "inventory";
        if (method === "alternate-link") return "alternate-link";
        if (method === "pattern" || method.includes("pattern")) return "pattern";
        return method;
      };
      const reasonOf = (method: string | null): string | null => {
        if (!method) return null;
        if (method === "existing") return "value already present in source workbook";
        if (method === "excluded-config") return "explicitly listed in Excludes sheet";
        if (method === "excluded-auto") return "no reference rows or constructed candidates available";
        if (method === "ai-match") return "AI matcher selected from per-tab inventory";
        if (method === "alternate-link") return "discovered via <link rel=alternate hreflang=...>";
        if (method.startsWith("title-semantic")) return "title embedding cosine similarity";
        if (method.startsWith("title")) return "title text overlap";
        if (method.startsWith("crawl") || method.includes("tail")) return "URL tail matched a crawled inventory entry";
        if (method.startsWith("inventory")) return "constructed URL found in crawled inventory";
        if (method === "pattern") return "constructed from learned URL pattern";
        return method;
      };
      const perLangDetails: Record<string, Record<string, unknown>> = {};
      const langPairs: Array<[TargetLang, string | null, MatchFlags | null]> = [
        ["en", matchMethodEn, match ? getResultFlags(match, "en") : null],
        ["fr", matchMethodFr, match ? getResultFlags(match, "fr") : null],
        ["ru", matchMethodRu, match ? getResultFlags(match, "ru") : null],
        ["ar", matchMethodAr, match ? getResultFlags(match, "ar") : null],
      ];
      // Task #84: per-row "why" trace, recorded by the title and AI matchers
      // for both committed and rejected (rowIndex, lang) pairs.
      const rowTrace = sheetTrace?.get(row.rowIndex);
      for (const [l, method, flags] of langPairs) {
        const stage = stageOf(method);
        const reason = reasonOf(method);
        const trace: RowLangTrace | undefined = rowTrace?.[l];
        if (!stage && !flags?.scoped && !flags?.crossScript && !trace) continue;
        const entry: Record<string, unknown> = {
          stage: stage,
          reason: reason,
          scoped: !!flags?.scoped,
          crossScript: !!flags?.crossScript,
        };
        if (trace) {
          // Compact form so the JSONB row stays small. Always carries the
          // last stage that considered this (row, lang) and its outcome;
          // top candidate URL/score and a short note are included only when
          // the matcher had something to say.
          const traceEntry: Record<string, unknown> = {
            stage: trace.stage,
            outcome: trace.outcome,
          };
          if (trace.topUrl) traceEntry.topUrl = trace.topUrl;
          if (typeof trace.topScore === "number") traceEntry.topScore = Math.round(trace.topScore * 1000) / 1000;
          if (trace.note) traceEntry.note = trace.note;
          // Task #84: persist actual top inventory candidates (≤3) so post-run
          // diagnostics can answer "what did the matcher see?" not just "what
          // was the best score?". Bounded by the matcher (top 3 by score) and
          // each entry is small ({url, score}), keeping JSONB row size modest.
          if (trace.topN && trace.topN.length > 0) {
            traceEntry.topN = trace.topN.slice(0, 3).map(c => ({
              url: c.url,
              score: Math.round(c.score * 1000) / 1000,
            }));
          }
          entry.trace = traceEntry;
        }
        perLangDetails[l] = entry;
      }

      resultBatch.push({
        jobId,
        sheetName: tabData.sheetName,
        rowIndex: row.rowIndex,
        title: row.title,
        sourceUrl: row.sourceUrl,
        englishUrl: enUrl,
        frenchUrl: frUrl,
        russianUrl: ruUrl,
        arabicUrl: arUrl,
        confidenceEn,
        confidenceFr,
        confidenceRu,
        confidenceAr,
        matchMethodEn,
        matchMethodFr,
        matchMethodRu,
        matchMethodAr,
        details: perLangDetails,
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
