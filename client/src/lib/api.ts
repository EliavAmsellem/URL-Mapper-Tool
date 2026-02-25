export interface JobStatus {
  id: string;
  fileName: string;
  status: string;
  totalUrls: number;
  processedUrls: number;
  matchedUrls: number;
  targetLanguages: string[];
  currentStep: string;
  createdAt: string;
}

export interface MappingResultRow {
  id: string;
  jobId: string;
  sheetName: string;
  rowIndex: number;
  title: string | null;
  sourceUrl: string;
  englishUrl: string | null;
  frenchUrl: string | null;
  russianUrl: string | null;
  arabicUrl: string | null;
  confidenceEn: number | null;
  confidenceFr: number | null;
  matchMethodEn: string | null;
  matchMethodFr: string | null;
  details: any;
}

export async function uploadFile(file: File, languages: string[] = ["en", "fr"]): Promise<{ jobId: string; totalUrls: number; sheets: string[] }> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("languages", languages.join(","));

  const res = await fetch("/api/upload", { method: "POST", body: formData });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Upload failed");
  }
  return res.json();
}

export async function startJob(jobId: string, threshold: number = 85): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threshold: threshold.toString() }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to start job");
  }
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) throw new Error("Failed to fetch job status");
  return res.json();
}

export async function getJobResults(jobId: string): Promise<MappingResultRow[]> {
  const res = await fetch(`/api/jobs/${jobId}/results`);
  if (!res.ok) throw new Error("Failed to fetch results");
  return res.json();
}

export interface ReferenceConflict {
  sourceUrl: string;
  targetUrl: string;
  lang: "en" | "fr";
  reason: string;
  expectedTargetDir: string;
  actualTargetDir: string;
  sheetName: string;
}

export async function getJobConflicts(jobId: string): Promise<ReferenceConflict[]> {
  const res = await fetch(`/api/jobs/${jobId}/conflicts`);
  if (!res.ok) return [];
  return res.json();
}

export function getDownloadUrl(jobId: string): string {
  return `/api/jobs/${jobId}/download`;
}

export interface CrawlSession {
  id: string;
  origin: string;
  rootPath: string;
  label: string | null;
  status: string;
  totalUrls: number;
  maxPages: number;
  maxDepth: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export async function getCrawlSessions(): Promise<CrawlSession[]> {
  const res = await fetch("/api/crawl/sessions");
  if (!res.ok) throw new Error("Failed to fetch crawl sessions");
  return res.json();
}

export async function getCrawlSession(id: string): Promise<CrawlSession> {
  const res = await fetch(`/api/crawl/sessions/${id}`);
  if (!res.ok) throw new Error("Failed to fetch crawl session");
  return res.json();
}

export async function startCrawl(data: {
  origin: string;
  rootPath: string;
  label?: string;
  maxPages?: number;
  maxDepth?: number;
}): Promise<CrawlSession> {
  const res = await fetch("/api/crawl", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to start crawl");
  }
  return res.json();
}

export async function refreshCrawl(id: string): Promise<CrawlSession> {
  const res = await fetch(`/api/crawl/sessions/${id}/refresh`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to refresh crawl");
  }
  return res.json();
}

export async function deleteCrawlSession(id: string): Promise<void> {
  const res = await fetch(`/api/crawl/sessions/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to delete crawl session");
  }
}