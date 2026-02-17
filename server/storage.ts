import {
  type MappingJob, type InsertMappingJob,
  type MappingResult, type InsertMappingResult,
  mappingJobs, mappingResults,
} from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";

export interface IStorage {
  createJob(job: InsertMappingJob): Promise<MappingJob>;
  getJob(id: string): Promise<MappingJob | undefined>;
  updateJob(id: string, updates: Partial<InsertMappingJob>): Promise<MappingJob | undefined>;
  createResult(result: InsertMappingResult): Promise<MappingResult>;
  createResults(results: InsertMappingResult[]): Promise<void>;
  getResultsByJob(jobId: string): Promise<MappingResult[]>;
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

  async getResultsByJob(jobId: string): Promise<MappingResult[]> {
    return db.select().from(mappingResults).where(eq(mappingResults.jobId, jobId));
  }
}

export const storage = new DatabaseStorage();