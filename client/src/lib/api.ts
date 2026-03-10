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

export async function stopJob(jobId: string): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}/stop`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to stop job");
  }
}

export function getDownloadUrl(jobId: string): string {
  return `/api/jobs/${jobId}/download`;
}