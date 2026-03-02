# LinguaMap - AI-Powered URL Alignment Tool

## Overview

LinguaMap is a multilingual URL mapping and site structure alignment tool. Users upload Excel/CSV files containing URLs, and the system automatically finds corresponding pages across different language versions of a website. It uses a **context-focused directory matching** approach: reference rows teach the system which source directories map to which target directories, then the system crawls target directories and matches pages within those scoped inventories.

The app follows a single-page application pattern with a three-phase workflow: file upload → processing with real-time progress → results display with export.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript (no routing library — single-page app with state-driven views)
- **Build tool**: Vite with path aliases (`@/` → `client/src/`, `@shared/` → `shared/`)
- **Styling**: Tailwind CSS v4 (using `@tailwindcss/vite` plugin) with CSS variables for theming
- **UI Components**: shadcn/ui (new-york style) with Radix UI primitives, stored in `client/src/components/ui/`
- **Animations**: Framer Motion for transitions between upload/processing/results views
- **State Management**: Local React state (useState) for app flow
- **Fonts**: Inter (UI) and JetBrains Mono (data/code display)

### Backend
- **Runtime**: Node.js with Express
- **Language**: TypeScript, executed via `tsx` in development
- **API Pattern**: REST endpoints under `/api/` prefix
- **File Handling**: Multer for file uploads (stored in `/tmp/uploads/`), XLSX library for parsing Excel/CSV files
- **Job System**: Asynchronous processing with polling — jobs are created on upload, started via API, and clients poll for status updates every 2 seconds

### Key API Endpoints
- `POST /api/upload` — Upload Excel/CSV file, creates a mapping job
- `POST /api/jobs/:id/start` — Start processing a job with a confidence threshold
- `GET /api/jobs/:id` — Poll job status (progress, step, counts)
- `GET /api/jobs/:id/results` — Fetch mapping results
- `GET /api/jobs/:id/conflicts` — Fetch reference conflicts detected during processing (returns `[]` if none)
- `GET /api/jobs/:id/download` — Download results as Excel with mapped URLs filled in

### Database
- **Database**: PostgreSQL (required, via `DATABASE_URL` environment variable)
- **ORM**: Drizzle ORM with `drizzle-kit` for schema management
- **Schema** (`shared/schema.ts`):
  - `mapping_jobs` — Tracks upload jobs with status, progress counters, target languages, and processing step
  - `mapping_results` — Stores per-URL mapping results with source/target URLs for each language, confidence scores, and match methods
  - `translation_cache` — Persistent cache for Hebrew→EN/FR translations (keyed by source_text + target_lang), avoids redundant API calls across runs
  - `crawl_sessions` — Tracks crawl session metadata: origin, rootPath, status (pending/crawling/completed/failed), totalUrls, maxPages, maxDepth, timestamps, optional label
  - `crawl_inventory_urls` — Stores discovered URLs per crawl session: url, title, linked to session via sessionId
- **Push migrations**: Use `npm run db:push` (drizzle-kit push) to sync schema to database

### Context-Focused Directory Matching Engine (`server/scraper.ts`)

The engine uses a **directory-scoped, crawl-inventory-based** approach. Instead of constructing URLs and verifying them with HEAD requests, it narrows the search space by mapping source directories to target directories, then matches pages within those scoped inventories.

#### Step 1: Reference Validation & Conflict Detection
Before learning patterns, reference pairs are validated using `validateReferenceRows`:
1. **Consensus voting** — For each source directory, all reference pairs vote on which target directory it maps to. The majority (≥2 votes, no tie) establishes the consensus.
2. **Direct conflict detection** — Any pair whose target directory disagrees with the established consensus is flagged. E.g., if 5 pairs say `/he/about/` → `/en/about/`, a pair mapping to `/en/benefit/` is flagged.
3. **Parent-child consistency** — Even directories with only one reference pair are checked: if the parent directory has a consensus mapping, child directories must map under the same target parent. Uses segment-based comparison, not string prefix.
4. **Exclusion, not deletion** — Flagged pairs are excluded from pattern learning but preserved in the data. Conflicts are saved to `/tmp/uploads/{jobId}_conflicts.json` and surfaced in the UI via `GET /api/jobs/:id/conflicts`.
5. Conflicts show as a collapsible warning panel in the results view with source URL, wrong target, and explanation.

#### Step 2: Pattern Learning & Directory Mapping
Each Excel tab contains pre-filled reference rows (after conflict removal) where source URLs already have their EN/FR equivalents. The engine:
1. Strips `default.aspx` suffixes from both source and target paths
2. Extracts **directory mappings** from reference pairs (e.g., `/he/about/pages/` → `/en/about/pages/`)
3. Finds common root mappings across all reference pairs
4. Builds segment-level translations for path components that differ
5. Stores directory mappings hierarchically — sub-directories inherit parent mappings

#### Step 3: Static Crawl Inventory (DB-backed)
- **Pre-crawled inventories** stored in PostgreSQL (`crawl_sessions` + `crawl_inventory_urls` tables) are the primary source of truth
- Jobs check DB for completed crawl sessions matching the target directory's origin+rootPath before falling back to live crawl
- **Prefix matching**: If the derived crawl root (e.g., `/English%20Homepage/`) doesn't match exactly, the system searches for DB sessions whose rootPath starts with the derived root (e.g., finds `/English%20Homepage/Benefits`) and combines their inventories
- **Crawl Manager UI** (`/crawl-manager`): Dedicated page for managing crawl sessions — start new crawls, view status, delete, or refresh existing sessions
- **Crawl parameters**: maxPages=2000, maxDepth=6 (BFS with per-URL depth tracking)
- **API endpoints**: `POST /api/crawl` (start), `GET /api/crawl/sessions` (list), `DELETE /api/crawl/sessions/:id`, `POST /api/crawl/sessions/:id/refresh`
- In-memory `crawlCache` Map provides fast caching after first DB load; cleared on server restart but repopulated from DB
- Each crawled page is indexed by: normalized path, tail segments (last 1-3 segments), page title, and word index

#### Step 4: Context-Focused Matching
For each unmatched source URL:
1. **Determine directory context** — Find which source directory the URL belongs to and look up the corresponding target directory
2. **Scope the inventory** — Filter the crawl inventory to only include pages under the mapped target directory
3. **Match within scope** using these strategies (in order):
   - **Pattern match** — Translate path segments and look for exact match in scoped inventory (confidence 95)
   - **Path match** — Match by relative path within the directory scope (confidence 93)
   - **Tail match** — Match on last 1-2 URL segments within scope (confidence 88-90)
   - **Translated tail match** — Translate segments then match tails (confidence 86)
   - **Fuzzy match** — Jaccard word-overlap similarity on last segments (confidence 80-90)
4. **Broad fallback** — If no match in scoped inventory, search the full inventory with reduced confidence (-5 points)

#### Step 5: Title-Based Matching
- For URLs still unmatched, page titles are translated Hebrew→EN/FR using Google Translate GTX endpoint
- Translated titles are fuzzy-matched against crawl inventory page titles using word-overlap similarity
- Title matching is also directory-scoped: unmatched URLs are grouped by their target directory, and title matching searches within the corresponding scoped inventory
- Section-aware scoring splits titles like "Topic - Page Name" and provides section similarity boosts
- 5 concurrent translation requests with rate limiting (200ms between batches)
- Translation results are cached persistently in the database `translation_cache` table

#### Step 6: AI-Powered Matching (Final Fallback)
- For URLs still unmatched after all deterministic steps, an AI agent (Claude Opus 4.6 via Replit Anthropic AI Integrations) attempts matching
- The AI receives **directory context** for each URL: which source directory it's from and the corresponding target directory
- AI gets the **full inventory** as candidates (up to INVENTORY_CAP=500 per language), with title-ranked URLs listed first for relevance
- Uniqueness is enforced at the acceptance stage: `usedEnUrls`/`usedFrUrls` sets prevent duplicate target URL assignments across batches
- AI is constrained to ONLY select from the crawl inventory — never invents URLs
- Batches of ~15 unmatched URLs are processed per API call
- JSON parse failures trigger an automatic retry via a reformatting AI call; failed responses are logged for debugging
- AI matches are labeled with method "dir-ai" and confidence score 82
- The system prompt emphasizes accuracy over completeness — better to return null than a wrong match
- The job `control` object is passed to the AI batch loop, allowing mid-batch cancellation via the "Stop after this round" button

#### Multi-Pass Processing
- Jobs automatically run up to 3 passes per processing run
- After each pass, newly matched URLs are treated as additional reference rows
- This expands directory mappings and segment translations for subsequent passes
- Processing stops early if a pass produces no new matches

#### Key Data Structures
- `TabPatterns`: Contains `directoryMappings`, `segmentMap`, `enRoot`, `frRoot`, `enSrcRoot`, `frSrcRoot`
- `DirectoryMapping`: Maps a source directory path to a target directory path for a specific language
- `CrawlInventory`: Full index of crawled URLs with normalized paths, tail segments, titles, and word indices
- Scoped inventories are derived from the full inventory by filtering to a specific directory prefix

#### Pipe-separated URL Handling
Source URL cells may contain Hebrew text prepended with a pipe character (e.g., `ביטוח לאומי|https://...`). The parser extracts the URL from after the pipe.

### Shared Code
- `shared/schema.ts` contains Drizzle table definitions, Zod insert schemas, and TypeScript types used by both client and server

### Development vs Production
- **Development**: Vite dev server runs as middleware through Express with HMR support (`server/vite.ts`)
- **Production**: Client is built to `dist/public/`, server is bundled with esbuild to `dist/index.cjs`, static files served by Express (`server/static.ts`)
- **Build command**: `npm run build` runs both Vite and esbuild builds via `script/build.ts`

## External Dependencies

### Required Services
- **PostgreSQL Database**: Must be provisioned and accessible via `DATABASE_URL` environment variable.

### Key NPM Packages
- `drizzle-orm` + `drizzle-kit` — Database ORM and migration tooling
- `xlsx` — Excel file reading and writing
- `multer` — Multipart file upload handling
- `framer-motion` — Client-side animations
- `cheerio` — HTML parsing for crawl inventory
- `zod` + `drizzle-zod` — Schema validation
- `@anthropic-ai/sdk` — Anthropic SDK for AI-powered URL matching (Claude Opus 4.6 via Replit AI Integrations)
- `GET /api/ai-config` — Returns the AI agent's full configuration (model, system prompt, user prompt template, validation pipeline, matching rules)

### External Web Requests
- The engine crawls target language directories via HTTP GET requests to build page inventories (30 concurrent, 8s timeout per page, max 2000 pages per crawl, max depth 6)
- Crawl inventories are persisted in the database and reused across jobs — live crawling is only a fallback when no DB inventory exists
- Title translations use the Google Translate GTX endpoint with rate limiting
