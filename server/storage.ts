import {
  type MappingJob, type InsertMappingJob,
  type MappingResult, type InsertMappingResult,
  mappingJobs, mappingResults, translationCache,
} from "@shared/schema";
import { db } from "./db";
import { eq, and } from "drizzle-orm";

export interface IStorage {
  createJob(job: InsertMappingJob): Promise<MappingJob>;
  getJob(id: string): Promise<MappingJob | undefined>;
  getAllJobs(): Promise<MappingJob[]>;
  updateJob(id: string, updates: Partial<InsertMappingJob>): Promise<MappingJob | undefined>;
  createResult(result: InsertMappingResult): Promise<MappingResult>;
  createResults(results: InsertMappingResult[]): Promise<void>;
  deleteResultsByJob(jobId: string): Promise<void>;
  getResultsByJob(jobId: string): Promise<MappingResult[]>;
  getCachedTranslation(sourceText: string, targetLang: string): Promise<string | null>;
  getCachedTranslations(targetLang: string): Promise<Map<string, string>>;
  saveCachedTranslations(entries: { sourceText: string; targetLang: string; translatedText: string }[]): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async createJob(job: InsertMappingJob): Promise<MappingJob> {
    const [created] = await db.insert(mappingJobs).values(job).returning();
    return created;
  }

  async getJob(id: string): Promise<MappingJob | undefined> {
    const [job] = await db.select().from(mappingJobs).where(eq(mappingJobs.id, id));
    return job;
  }

  async getAllJobs(): Promise<MappingJob[]> {
    return db.select().from(mappingJobs);
  }

  async updateJob(id: string, updates: Partial<InsertMappingJob>): Promise<MappingJob | undefined> {
    const [updated] = await db.update(mappingJobs).set(updates).where(eq(mappingJobs.id, id)).returning();
    return updated;
  }

  async createResult(result: InsertMappingResult): Promise<MappingResult> {
    const [created] = await db.insert(mappingResults).values(result).returning();
    return created;
  }

  async createResults(results: InsertMappingResult[]): Promise<void> {
    if (results.length === 0) return;
    const batchSize = 100;
    for (let i = 0; i < results.length; i += batchSize) {
      await db.insert(mappingResults).values(results.slice(i, i + batchSize));
    }
  }

  async deleteResultsByJob(jobId: string): Promise<void> {
    await db.delete(mappingResults).where(eq(mappingResults.jobId, jobId));
  }

  async getResultsByJob(jobId: string): Promise<MappingResult[]> {
    return db.select().from(mappingResults).where(eq(mappingResults.jobId, jobId));
  }

  async getCachedTranslation(sourceText: string, targetLang: string): Promise<string | null> {
    const [row] = await db.select().from(translationCache)
      .where(and(
        eq(translationCache.sourceText, sourceText),
        eq(translationCache.targetLang, targetLang)
      ))
      .limit(1);
    return row?.translatedText || null;
  }

  async getCachedTranslations(targetLang: string): Promise<Map<string, string>> {
    const rows = await db.select().from(translationCache)
      .where(eq(translationCache.targetLang, targetLang));
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.sourceText, row.translatedText);
    }
    return map;
  }

  async saveCachedTranslations(entries: { sourceText: string; targetLang: string; translatedText: string }[]): Promise<void> {
    if (entries.length === 0) return;
    const batchSize = 100;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize).map(e => ({
        sourceText: e.sourceText,
        sourceLang: "he",
        targetLang: e.targetLang,
        translatedText: e.translatedText,
      }));
      await db.insert(translationCache).values(batch).onConflictDoNothing();
    }
  }
}

export const storage = new DatabaseStorage();