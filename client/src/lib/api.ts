export interface JobStatus {
  id: string;
  fileName: string;
  status: string;
  totalUrls: number;
  processedUrls: number;
  matchedUrls: number;
  prefilledUrls: number;
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
  confidenceRu: number | null;
  confidenceAr: number | null;
  matchMethodEn: string | null;
  matchMethodFr: string | null;
  matchMethodRu: string | null;
  matchMethodAr: string | null;
  details: any;
}

export async function uploadFile(file: File, languages: string[]): Promise<{ jobId: string; totalUrls: number; sheets: string[] }> {
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

export const LANG_OPTIONS = [
  { code: "en", label: "EN", name: "English" },
  { code: "fr", label: "FR", name: "French" },
  { code: "ru", label: "RU", name: "Russian" },
  { code: "ar", label: "AR", name: "Arabic" },
] as const;

export type LangCode = typeof LANG_OPTIONS[number]["code"];

export const LANG_META: Record<string, {
  label: string;
  urlKey: keyof MappingResultRow;
  confKey: keyof MappingResultRow;
  methodKey: keyof MappingResultRow;
}> = {
  en: { label: "English URL", urlKey: "englishUrl", confKey: "confidenceEn", methodKey: "matchMethodEn" },
  fr: { label: "French URL", urlKey: "frenchUrl", confKey: "confidenceFr", methodKey: "matchMethodFr" },
  ru: { label: "Russian URL", urlKey: "russianUrl", confKey: "confidenceRu", methodKey: "matchMethodRu" },
  ar: { label: "Arabic URL", urlKey: "arabicUrl", confKey: "confidenceAr", methodKey: "matchMethodAr" },
};
