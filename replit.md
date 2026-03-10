# LinguaMap - AI-Powered URL Alignment Tool

## Overview

LinguaMap is a multilingual URL mapping and site structure alignment tool. Users upload Excel/CSV files containing URLs, and the system automatically finds corresponding pages across different language versions of a website. It uses pattern-based URL construction learned from reference rows in each Excel tab, with HEAD request verification to confirm URL existence.

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
- **URL Verification**: Batch HEAD requests with 50 concurrent connections, 3s timeout, and URL existence caching
- **Job System**: Asynchronous processing with polling — jobs are created on upload, started via API, and clients poll for status updates every 2 seconds

### Key API Endpoints
- `POST /api/upload` — Upload Excel/CSV file, creates a mapping job
- `POST /api/jobs/:id/start` — Start processing a job with a confidence threshold
- `GET /api/jobs/:id` — Poll job status (progress, step, counts)
- `GET /api/jobs/:id/results` — Fetch mapping results
- `GET /api/jobs/:id/download` — Download results as Excel with mapped URLs filled in

### Database
- **Database**: PostgreSQL (required, via `DATABASE_URL` environment variable)
- **ORM**: Drizzle ORM with `drizzle-kit` for schema management
- **Schema** (`shared/schema.ts`):
  - `mapping_jobs` — Tracks upload jobs with status, progress counters, target languages, and processing step
  - `mapping_results` — Stores per-URL mapping results with source/target URLs for each language, confidence scores, and match methods
  - `translation_cache` — Persistent cache for Hebrew→EN/FR translations (keyed by source_text + target_lang), avoids redundant API calls across runs
- **Push migrations**: Use `npm run db:push` (drizzle-kit push) to sync schema to database

### Pattern-Based URL Construction Engine (`server/scraper.ts`)

The engine uses a three-step approach:

#### Step 1: Pattern Learning from Reference Rows
Each Excel tab contains pre-filled reference rows where source URLs already have their EN/FR equivalents. The engine:
1. Strips `default.aspx` suffixes from both source and target paths
2. Performs fuzzy tail-matching from the end of path segments (normalizing underscores, spaces, and percent-encoding)
3. Identifies the "source root" (segments unique to source path) and "target root" (segments unique to target path)
4. Finds common root mappings across all reference pairs in a tab
5. Builds segment-level translations for path components that differ

Example: Source `/HaravotBarzel1/Harada_HB/Pages/` → EN `/English%20Homepage/Updates-security-situation/Harada_HB/Pages/`
- Source root: `HaravotBarzel1`
- Target root: `English%20Homepage/Updates-security-situation`
- Tail match: `Harada_HB/Pages`

#### Step 2: URL Construction
For each source URL needing a target:
1. Strip `default.aspx` suffix
2. Replace source root segments with target root segments
3. Apply segment-level translations to remaining path parts
4. Construct full target URL

#### Step 3: Crawl Inventory Matching
- Directory crawling builds an inventory of all URLs in target language sections
- Exact match against constructed URLs (confidence 95)
- Normalized path matching (confidence 93)
- Tail-segment matching from the end of URL paths (confidence 85-88)
- Segment fuzzy matching using word-overlap Jaccard similarity (confidence 80-90)
- Translated segment matching using learned segment translations (confidence 86)

#### Step 4: Batch HEAD Verification
- All constructed URLs are verified with HTTP HEAD requests (50 concurrent, 3s timeout)
- URLs returning non-200 status are discarded
- Verified URLs get confidence score of 90

#### Step 5: Title-Based Matching with Section Awareness
- For URLs still unmatched after pattern/crawl matching, page titles are extracted and translated Hebrew→EN/FR using Google Translate GTX endpoint
- Translated titles are fuzzy-matched against crawl inventory page titles using word-overlap similarity
- **Section-aware scoring**: Titles like "Unemployment - Conditions of entitlement" are split into section prefix ("Unemployment") and page name ("Conditions of entitlement"). When both source and target titles have section prefixes, matching sections provide a similarity boost (up to +0.15), helping disambiguate pages with similar names across different website sections
- Section matching is purely additive (boost-only) — it never excludes or penalizes candidates, preserving recall
- 5 concurrent translation requests with rate limiting (200ms between batches)
- Translation results are cached persistently in the database `translation_cache` table

#### Step 6: AI-Powered Matching (Final Fallback)
- For URLs still unmatched after all deterministic steps, an AI agent (GPT-5-mini via Replit AI Integrations) attempts matching
- The AI receives: unmatched source URLs with translated titles, the full crawl inventory of available target URLs, learned URL patterns and segment translations, and examples of already-matched pairs
- AI is constrained to ONLY select from the crawl inventory — never invents URLs
- Batches of ~15 unmatched URLs are processed per API call
- All AI-suggested URLs are HEAD-verified before acceptance (same as pattern matches)
- AI matches are labeled with method "ai-match" and confidence score 82
- Duplicate prevention: AI cannot reuse URLs already assigned by earlier matching steps
- The system prompt emphasizes accuracy over completeness — better to return null than a wrong match

#### Multi-Pass Processing
- Jobs automatically run up to 3 passes per processing run
- After each pass, newly matched URLs are treated as additional reference rows for learning improved transformation patterns
- Subsequent passes re-run pattern learning and matching on remaining unmatched URLs
- Processing stops early if a pass produces no new matches
- This eliminates the need for manual download→re-upload cycles to improve match rates

#### Key Data Structures
- `TabPatterns`: Contains `enRoot`, `frRoot`, `enSrcRoot`, `frSrcRoot`, `segmentMap`, `patternValidated`
- `RootMapping`: Contains `sourceRoot` and `targetRoot` arrays
- Patterns are auto-trusted when derived from reference rows (no sample validation needed)

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
- `papaparse` — CSV parsing (client-side)
- `zod` + `drizzle-zod` — Schema validation
- `openai` — OpenAI SDK for AI-powered URL matching (via Replit AI Integrations)

### External Web Requests
- The engine makes HTTP HEAD requests to verify constructed target URLs exist. Uses 50 concurrent connections with a 3s timeout per request and an in-memory existence cache to avoid redundant checks.
