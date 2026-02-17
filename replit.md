# LinguaMap - AI-Powered URL Alignment Tool

## Overview

LinguaMap is a multilingual URL mapping and site structure alignment tool. Users upload Excel/CSV files containing URLs, and the system automatically finds corresponding pages across different language versions of a website. It works by scraping page metadata (titles, og:tags, slugs, DOM structure) and using heuristic matching algorithms to align URLs across languages (primarily English and French, with support for Russian and Arabic).

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
- **Web Scraping**: Cheerio for HTML parsing, native `fetch` for HTTP requests with rate limiting (300ms between requests) and 15s timeout
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
- **Push migrations**: Use `npm run db:push` (drizzle-kit push) to sync schema to database

### Scraping Engine (`server/scraper.ts`)
The scraper extracts metadata from URLs including:
- Page title and og:title
- H1 content
- URL slug tokens
- Breadcrumb depth
- Body CSS classes and language attributes

### Matching Algorithm
Multi-step confidence scoring:
- **Step 1 (Slug - 30%)**: Jaccard similarity of URL path tokens
- **Step 2 (Metadata - 50%)**: Best match across title, og:title, and H1
- **Step 3 (Structure - 20%)**: Breadcrumb depth and CSS class overlap
- **Threshold**: Only populate cell if total confidence > 85%

### Candidate URL Generation
`inferLanguageUrl()` generates candidate URLs by:
1. Replacing the first path segment with the target language prefix (e.g., `English%20Homepage`, `French%20homepage`)
2. Trying different path combinations based on the source URL structure
3. De-duplicating candidate list

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
- `cheerio` — Server-side HTML parsing for web scraping
- `xlsx` — Excel file reading and writing
- `multer` — Multipart file upload handling
- `framer-motion` — Client-side animations
- `papaparse` — CSV parsing (client-side)
- `zod` + `drizzle-zod` — Schema validation

### External Web Requests
- The scraper makes HTTP requests to user-provided URLs to fetch page metadata. It uses a custom User-Agent string and includes rate limiting (300ms) to avoid overwhelming target servers.