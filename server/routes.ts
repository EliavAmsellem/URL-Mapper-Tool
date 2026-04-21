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
  setResultMatch,
  clearResultMatch,
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
        if (isSeedsSheet(worksheet.name)) continue;
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

      res.json({ jobId: job.id, totalUrls, sheets: workbook.worksheets.filter(ws => !isSeedsSheet(ws.name)).map(ws => ws.name) });
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
          existingControl.abortController.abort();
          await storage.updateJob(existingJobId, { status: "cancelled", currentStep: "done" });
          activeJobs.delete(existingJobId);
        }
      }

      const control = newJobControl();
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

      const outputPath = `/tmp/uploads/${jobId}_output.xlsx`;
      await workbook.xlsx.writeFile(outputPath);

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
): Promise<{
  matchResults: Map<number, BatchMatchResult>;
  inventories: Record<TargetLang, CrawlInventory | null>;
  tabPatterns: TabPatterns;
  usedUrls: Record<TargetLang, Set<string>>;
}> {
  const { sheetName, allRows, tabRefRows } = tabData;
  const allLangsLocal: TargetLang[] = ["en", "fr", "ru", "ar"];
  const langs: TargetLang[] = allLangsLocal.filter(l => targetLangs.includes(l));
  const langLabels: Record<TargetLang, string> = { en: "EN", fr: "FR", ru: "RU", ar: "AR" };
  const refUrlKey: Record<TargetLang, "enUrl" | "frUrl" | "ruUrl" | "arUrl"> = { en: "enUrl", fr: "frUrl", ru: "ruUrl", ar: "arUrl" };

  const tabPatterns = learnTabPatterns(tabRefRows, langs);
  if (globalPatterns) {
    const { addedSegments, addedPairs } = mergeIntoTabPatterns(tabPatterns, globalPatterns, langs);
    const segParts = langs.map(l => `${addedSegments[l]} ${l.toUpperCase()}`).filter(s => !s.startsWith("0 "));
    const pairParts = langs.map(l => `${addedPairs[l]} ${l.toUpperCase()}`).filter(s => !s.startsWith("0 "));
    if (segParts.length > 0 || pairParts.length > 0) {
      log(`Tab "${sheetName}": merged from global registry — segments[${segParts.join(", ") || "none"}], root mappings[${pairParts.join(", ") || "none"}]`);
    }
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
    return { matchResults, inventories, tabPatterns, usedUrls };
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
    if (userSeed) {
      const userPath = userSeed.map(s => s.toLowerCase()).join("/");
      const droppedAuto = anchorRoots.filter(a => {
        const ap = a.map(s => s.toLowerCase()).join("/");
        return !(ap === userPath || ap.startsWith(userPath + "/"));
      }).length;
      log(`  ${langLabels[l]}: anchor source=user-provided /${userSeed.join("/")}/ (${anchorRoots.length} auto-anchors considered, ${droppedAuto} outside user scope dropped)`);
      crawlScopes = [userSeed];
    } else if (anchorRoots.length > 0) {
      const sorted = anchorRoots.slice().sort((a, b) => a.length - b.length);
      const kept: string[][] = [];
      for (const cand of sorted) {
        const candPath = cand.map(s => s.toLowerCase()).join("/");
        const isDescendant = kept.some(anc => {
          const ancPath = anc.map(s => s.toLowerCase()).join("/");
          return candPath === ancPath || candPath.startsWith(ancPath + "/");
        });
        if (!isDescendant) kept.push(cand);
      }
      if (kept.length < anchorRoots.length) {
        log(`  ${langLabels[l]}: coalesced ${anchorRoots.length} raw anchors → ${kept.length} top-level anchor(s)`);
      }
      log(`  ${langLabels[l]}: anchor source=auto-inferred (${kept.length} anchor(s))`);
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
        if (match && !usedUrls[l].has(match.url)) {
          setResultMatch(result, l, match.url, match.confidence, match.method);
          usedUrls[l].add(match.url);
          methodCounts[match.method] = (methodCounts[match.method] || 0) + 1;
          inventoryMatchCount++;
          sectionStats[section][`${l}Matched`]++;
        } else {
          if (match) dedupBlockedCount++; else inventoryMissCount++;
          sectionStats[section][`${l}Missed`]++;
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
          for (const candidate of allCandidates) {
            if (!usedUrls[l].has(candidate)) {
              unmatchedForHead.push({ index: row.rowIndex, lang: l, constructedUrl: candidate, sourceUrl: row.sourceUrl });
            }
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

  // ---- CROSS-SCRIPT DETECTION ----
  // Tabs whose source slugs are in a different script/vocabulary from the
  // target inventory slugs (e.g. EN sources `/benefits/Disability` vs RU
  // inventory `/Benefits_ru/Nehut_ru/`) make the title-match "no shared
  // segments → reject" rail a false-positive generator. Detect once per tab
  // from reference rows and disable the rail per-lang downstream.
  const crossScriptLangs = detectCrossScriptLangs(tabRefRows, langs);

  // ---- PASS 1.5: ALTERNATE-LINK HARVEST ----
  // For rows that Pattern+Crawl couldn't place, fetch the source HTML once
  // and look for `<link rel="alternate" hreflang>` (and `<a hreflang>`) that
  // points into our crawled inventory. This is especially valuable on
  // cross-script tabs where the segment learner has no usable training pairs.
  // We only run harvest for tabs that have at least one cross-script lang
  // among the active langs, to bound the cost (one HTTP GET per missed row).
  const harvestNeeded = langs.some(l => crossScriptLangs[l] && inventories[l]);
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
            setResultMatch(result, l, url, 95, "alternate-link");
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

    const titleMatches = await titleMatchUnmatched(
      unmatchedForTitle, inventories, storage,
      allowedRoots, refDepths, knownUrlSets, control.signal, crossScriptLangs,
    );

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
          setResultMatch(result, l, tUrl, getResultConf(titleResult, l) || 0, taggedMethod);
          usedUrls[l].add(tUrl);
          titleAcceptedTotal++;
          titleMethodCounts[taggedMethod] = (titleMethodCounts[taggedMethod] || 0) + 1;
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
            continue;
          }
          if (srcDepth >= 3 && tgtDepth <= 1) {
            log(`    HEAD match REJECTED (too shallow): ${item.sourceUrl} -> ${verifiedUrl}`);
            headDepthRejected++;
            continue;
          }
        } catch {}

        if (usedUrls[item.lang].has(verifiedUrl)) continue;

        const result = matchResults.get(item.index);
        if (result && !getResultUrl(result, item.lang)) {
          const method = wasRedirected ? "head-verified+redirect" : "head-verified";
          setResultMatch(result, item.lang, verifiedUrl, 90, method);
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

  return { matchResults, inventories, tabPatterns, usedUrls };
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
  for (const worksheet of workbook.worksheets) {
    if (isSeedsSheet(worksheet.name)) {
      seedsSheet = worksheet;
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
    matchedCount = preExistingMatches;
    log(`Job ${jobId} found ${preExistingMatches} pre-existing match row(s) in upload (counted toward total)`);
    await storage.updateJob(jobId, { matchedUrls: matchedCount });
  }
  const needsKey: Record<TargetLang, keyof RowData> = { en: "needsEn", fr: "needsFr", ru: "needsRu", ar: "needsAr" };
  const refUrlKey: Record<TargetLang, "enUrl" | "frUrl" | "ruUrl" | "arUrl"> = { en: "enUrl", fr: "frUrl", ru: "ruUrl", ar: "arUrl" };

  const globalMatchResults = new Map<string, Map<number, BatchMatchResult>>();
  const tabInventories = new Map<string, { inventories: Record<TargetLang, CrawlInventory | null>; tabPatterns: TabPatterns; usedUrls: Record<TargetLang, Set<string>> }>();

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
  const rebuildGlobalRefRows = (): TabRefRow[] => {
    const rows: TabRefRow[] = [];
    for (const td of allTabData) {
      const sheetGlobal = globalMatchResults.get(td.sheetName);
      for (const row of td.allRows) {
        const m = sheetGlobal?.get(row.rowIndex);
        const ref: TabRefRow = { sourceUrl: row.sourceUrl };
        let any = false;
        for (const l of allLangs) {
          const existing = getRowExisting(row, l);
          const found = m ? getResultUrl(m, l) : null;
          const url = existing || found || undefined;
          if (url) {
            (ref as any)[refUrlKey[l]] = url;
            any = true;
          }
        }
        if (any) rows.push(ref);
      }
    }
    return rows;
  };

  let globalRefRows = rebuildGlobalRefRows();
  let globalPatterns = learnTabPatterns(globalRefRows, activeLangs, { silent: true, label: "[global]" });
  log(`Job ${jobId}: global pattern registry seeded from ${globalRefRows.length} confirmed pair(s) across ${allTabData.length} tab(s)`);
  const segLines = summarizeSegmentTranslations(globalPatterns, activeLangs);
  if (segLines.length > 0) {
    log(`Job ${jobId}: global segment translations:`);
    for (const line of segLines) log(line);
  }

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (control.cancel) break;

    const passStartTime = Date.now();
    let passNewMatches = 0;

    if (pass > 1) {
      log(`\n========== PASS ${pass} ==========`);
      log(`Re-learning patterns from updated reference rows...`);
      updateRowsFromResults(allTabData, globalMatchResults);
    }

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

      const { matchResults, inventories: tabInv, tabPatterns, usedUrls: tabUsed } = await matchTab(tabData, crawlCache, control, activeLangs, effectiveCap, seedMap.get(tabData.sheetName), alternateLinkCache, globalPatterns);
      tabInventories.set(tabData.sheetName, { inventories: tabInv, tabPatterns, usedUrls: tabUsed });

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
              setResultMatch(existing, l, url, getResultConf(result, l) || 0, getResultMethod(result, l) || "");
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
        const segDelta = activeLangs
          .map(l => ({ l, d: (globalPatterns.segmentMap.get(l)?.size || 0) - prevSegs[l] }))
          .filter(x => x.d > 0)
          .map(x => `+${x.d} ${x.l.toUpperCase()}`)
          .join(", ");
        log(`Global registry refreshed: ${globalRefRows.length} pairs (was ${prevSize})${segDelta ? `, segment translations ${segDelta}` : ""}`);
      }
    }

    const passTime = ((Date.now() - passStartTime) / 1000).toFixed(1);
    log(`\nPass ${pass} completed in ${passTime}s: ${passNewMatches} new matches`);

    if (pass > 1 && passNewMatches === 0) {
      log(`No new matches in pass ${pass}, stopping multi-pass.`);
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

      const unmatchedForAi = tabData.allRows.filter(row => {
        if (!row.title) return false;
        const m = sheetGlobal.get(row.rowIndex);
        return allLangs.some(l => row[needsKey[l]] && (!m || !getResultUrl(m, l)));
      }).map(row => {
        const m = sheetGlobal.get(row.rowIndex);
        const needs: Record<TargetLang, boolean> = { en: false, fr: false, ru: false, ar: false };
        for (const l of allLangs) {
          needs[l] = !!(row[needsKey[l]] && (!m || !getResultUrl(m, l)));
        }
        return { rowIndex: row.rowIndex, title: row.title, sourceUrl: row.sourceUrl, needs };
      });

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

      const aiMatches = await aiMatchUnmatched(
        unmatchedForAi,
        effectiveInventories,
        inv.tabPatterns,
        matchedExamples,
        allTranslations,
        knownUrlSets,
        control.signal,
      );

      if (aiMatches.size > 0) {
        const aiUrls: string[] = [];
        for (const [, aiResult] of Array.from(aiMatches.entries())) {
          for (const l of allLangs) {
            const url = getResultUrl(aiResult, l);
            if (url) aiUrls.push(url);
          }
        }

        log(`  HEAD-verifying ${aiUrls.length} AI-suggested URLs...`);
        const existence = await batchHeadCheck(aiUrls, control.signal);

        const rowSourceMap = new Map<number, string>();
        for (const r of unmatchedForAi) {
          rowSourceMap.set(r.rowIndex, r.sourceUrl);
        }

        let aiAccepted = 0;
        let aiHeadRejected = 0;
        let aiDepthRejected = 0;
        let aiRedirRescued = 0;
        const aiVerifiedUrls = new Map<string, string>();

        for (const [rowIndex, aiResult] of Array.from(aiMatches.entries())) {
          const srcUrl = rowSourceMap.get(rowIndex) || "";

          for (const l of allLangs) {
            const url = getResultUrl(aiResult, l);
            if (!url) continue;
            const probe = existence.get(url);
            if (!probe || !probe.ok) {
              log(`    AI HEAD REJECTED: ${l.toUpperCase()} ${url}`);
              clearResultMatch(aiResult, l);
              aiHeadRejected++;
            } else if (probe.finalUrl && probe.finalUrl !== url) {
              aiVerifiedUrls.set(`${rowIndex}:${l}`, probe.finalUrl);
              aiRedirRescued++;
            }
          }

          for (const l of allLangs) {
            const url = getResultUrl(aiResult, l);
            const sr = langSrcRoot(inv.tabPatterns, l);
            if (url && srcUrl && sr.length > 0) {
              const verifiedUrl = aiVerifiedUrls.get(`${rowIndex}:${l}`) || url;
              if (!validateDepthMatch(srcUrl, verifiedUrl, sr, langRoot(inv.tabPatterns, l))) {
                log(`    AI DEPTH REJECTED: ${l.toUpperCase()} ${verifiedUrl}`);
                clearResultMatch(aiResult, l);
                aiDepthRejected++;
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
              const verifiedUrl = aiVerifiedUrls.get(`${rowIndex}:${l}`) || url;
              if (!getResultUrl(existing, l) && !inv.usedUrls[l].has(verifiedUrl)) {
                const baseMethod = getResultMethod(aiResult, l) || "";
                const method = verifiedUrl !== url ? `${baseMethod}+redirect` : baseMethod;
                setResultMatch(existing, l, verifiedUrl, getResultConf(aiResult, l) || 0, method);
                inv.usedUrls[l].add(verifiedUrl);
                aiAccepted++;
              }
            }
          }
        }

        matchedCount += aiAccepted;
        log(`  AI results: ${aiAccepted} accepted, ${aiHeadRejected} HEAD-rejected, ${aiDepthRejected} depth-rejected${aiRedirRescued > 0 ? `, ${aiRedirRescued} via redirect rescue` : ''}`);
        await storage.updateJob(jobId, { matchedUrls: matchedCount });
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

      const rowFinalUrls: Record<TargetLang, string | null> = { en: enUrl, fr: frUrl, ru: ruUrl, ar: arUrl };
      const rowHasAnyActive = activeLangsForCount.some(l => !!rowFinalUrls[l]);
      if (rowHasAnyActive) finalMatchedCount++;

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
