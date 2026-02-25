import {
  type MappingJob, type InsertMappingJob,
  type MappingResult, type InsertMappingResult,
  type CrawlSession, type InsertCrawlSession,
  type CrawlInventoryUrl, type InsertCrawlInventoryUrl,
  mappingJobs, mappingResults, translationCache,
  crawlSessions, crawlInventoryUrls,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc } from "drizzle-orm";

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
  createCrawlSession(session: InsertCrawlSession): Promise<CrawlSession>;
  getCrawlSession(id: string): Promise<CrawlSession | undefined>;
  getCrawlSessions(): Promise<CrawlSession[]>;
  updateCrawlSession(id: string, updates: Partial<InsertCrawlSession>): Promise<CrawlSession | undefined>;
  deleteCrawlSession(id: string): Promise<void>;
  findCompletedCrawlSession(origin: string, rootPath: string): Promise<CrawlSession | undefined>;
  saveCrawlInventory(sessionId: string, urls: { url: string; title?: string }[]): Promise<void>;
  loadCrawlInventory(sessionId: string): Promise<{ url: string; title: string | null }[]>;
  deleteCrawlInventory(sessionId: string): Promise<void>;
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

  async createCrawlSession(session: InsertCrawlSession): Promise<CrawlSession> {
    const [created] = await db.insert(crawlSessions).values(session).returning();
    return created;
  }

  async getCrawlSession(id: string): Promise<CrawlSession | undefined> {
    const [session] = await db.select().from(crawlSessions).where(eq(crawlSessions.id, id));
    return session;
  }

  async getCrawlSessions(): Promise<CrawlSession[]> {
    return db.select().from(crawlSessions).orderBy(desc(crawlSessions.createdAt));
  }

  async updateCrawlSession(id: string, updates: Partial<InsertCrawlSession>): Promise<CrawlSession | undefined> {
    const [updated] = await db.update(crawlSessions).set(updates).where(eq(crawlSessions.id, id)).returning();
    return updated;
  }

  async deleteCrawlSession(id: string): Promise<void> {
    await db.delete(crawlInventoryUrls).where(eq(crawlInventoryUrls.sessionId, id));
    await db.delete(crawlSessions).where(eq(crawlSessions.id, id));
  }

  async findCompletedCrawlSession(origin: string, rootPath: string): Promise<CrawlSession | undefined> {
    const [session] = await db.select().from(crawlSessions)
      .where(and(
        eq(crawlSessions.origin, origin),
        eq(crawlSessions.rootPath, rootPath),
        eq(crawlSessions.status, "completed")
      ))
      .orderBy(desc(crawlSessions.completedAt))
      .limit(1);
    return session;
  }

  async saveCrawlInventory(sessionId: string, urls: { url: string; title?: string }[]): Promise<void> {
    if (urls.length === 0) return;
    await db.delete(crawlInventoryUrls).where(eq(crawlInventoryUrls.sessionId, sessionId));
    const batchSize = 200;
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize).map(u => ({
        sessionId,
        url: u.url,
        title: u.title || null,
      }));
      await db.insert(crawlInventoryUrls).values(batch);
    }
  }

  async loadCrawlInventory(sessionId: string): Promise<{ url: string; title: string | null }[]> {
    return db.select({ url: crawlInventoryUrls.url, title: crawlInventoryUrls.title })
      .from(crawlInventoryUrls)
      .where(eq(crawlInventoryUrls.sessionId, sessionId));
  }

  async deleteCrawlInventory(sessionId: string): Promise<void> {
    await db.delete(crawlInventoryUrls).where(eq(crawlInventoryUrls.sessionId, sessionId));
  }
}

export const storage = new DatabaseStorage();