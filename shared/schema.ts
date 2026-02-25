import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const mappingJobs = pgTable("mapping_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("pending"),
  totalUrls: integer("total_urls").notNull().default(0),
  processedUrls: integer("processed_urls").notNull().default(0),
  matchedUrls: integer("matched_urls").notNull().default(0),
  targetLanguages: text("target_languages").array().notNull().default(sql`ARRAY['en','fr']`),
  currentStep: text("current_step").default("idle"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const mappingResults = pgTable("mapping_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull(),
  sheetName: text("sheet_name").notNull(),
  rowIndex: integer("row_index").notNull(),
  title: text("title"),
  sourceUrl: text("source_url").notNull(),
  englishUrl: text("english_url"),
  frenchUrl: text("french_url"),
  russianUrl: text("russian_url"),
  arabicUrl: text("arabic_url"),
  confidenceEn: integer("confidence_en"),
  confidenceFr: integer("confidence_fr"),
  matchMethodEn: text("match_method_en"),
  matchMethodFr: text("match_method_fr"),
  details: jsonb("details"),
});

export const translationCache = pgTable("translation_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceText: text("source_text").notNull(),
  sourceLang: text("source_lang").notNull().default("he"),
  targetLang: text("target_lang").notNull(),
  translatedText: text("translated_text").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const crawlSessions = pgTable("crawl_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  origin: text("origin").notNull(),
  rootPath: text("root_path").notNull(),
  label: text("label"),
  status: text("status").notNull().default("pending"),
  totalUrls: integer("total_urls").notNull().default(0),
  maxPages: integer("max_pages").notNull().default(2000),
  maxDepth: integer("max_depth").notNull().default(6),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const crawlInventoryUrls = pgTable("crawl_inventory_urls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull(),
  url: text("url").notNull(),
  title: text("title"),
});

export const insertMappingJobSchema = createInsertSchema(mappingJobs).omit({ id: true, createdAt: true });
export const insertMappingResultSchema = createInsertSchema(mappingResults).omit({ id: true });
export const insertTranslationCacheSchema = createInsertSchema(translationCache).omit({ id: true, createdAt: true });
export const insertCrawlSessionSchema = createInsertSchema(crawlSessions).omit({ id: true, createdAt: true });
export const insertCrawlInventoryUrlSchema = createInsertSchema(crawlInventoryUrls).omit({ id: true });

export type InsertMappingJob = z.infer<typeof insertMappingJobSchema>;
export type MappingJob = typeof mappingJobs.$inferSelect;
export type InsertMappingResult = z.infer<typeof insertMappingResultSchema>;
export type MappingResult = typeof mappingResults.$inferSelect;
export type CrawlSession = typeof crawlSessions.$inferSelect;
export type InsertCrawlSession = z.infer<typeof insertCrawlSessionSchema>;
export type CrawlInventoryUrl = typeof crawlInventoryUrls.$inferSelect;
export type InsertCrawlInventoryUrl = z.infer<typeof insertCrawlInventoryUrlSchema>;