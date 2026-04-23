# LinguaMap - AI-Powered URL Alignment Tool

## Overview

LinguaMap is an AI-powered tool designed to automatically align and map URLs across different language versions of a website. Users upload Excel/CSV files containing source URLs, and the system identifies corresponding pages in target languages (e.g., English, French). It leverages pattern-based URL construction, real-time verification, and advanced matching strategies, including AI, to achieve high accuracy. The project aims to streamline the complex process of multilingual site synchronization, offering a robust solution for webmasters and content managers.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX
The application is a single-page React 18 application built with TypeScript and Vite. It uses Tailwind CSS for styling and `shadcn/ui` for UI components, ensuring a modern and consistent user experience. Framer Motion handles transitions, providing a fluid workflow through the upload, processing, and results phases. Fonts include Inter for UI and JetBrains Mono for data display.

### Technical Implementation
The backend is built with Node.js and Express, written in TypeScript. It provides a RESTful API for file uploads, job management, and results retrieval. File handling uses Multer for uploads and the `xlsx` library for parsing. URL verification is performed via batch HEAD requests with concurrency and caching. A job system handles asynchronous processing, allowing clients to poll for real-time status updates.

### Feature Specifications
LinguaMap employs a sophisticated pattern-based URL construction engine. This engine learns URL transformation patterns from reference rows in uploaded files, enabling it to construct candidate target URLs. It uses a multi-step matching process:
1.  **Pattern Learning**: Identifies source and target roots and segment-level translations from reference URLs.
2.  **URL Construction**: Generates candidate URLs from ALL applicable per-pair root mappings (not just the longest match) via `constructAllTargetUrls`, handling cases where reference data has conflicting mappings for the same source subsection.
3.  **Crawl Inventory Matching**: Prioritizes matching against an inventory of URLs discovered by crawling target language sections, including SharePoint-specific directory discovery. This also includes global deduplication to ensure each target URL is mapped only once.
3a. **Cross-Script Tab Detection** (`detectCrossScriptLangs`): Per (tab, lang), measures how many reference (sourceUrl, targetUrl) pairs share at least one normalized path segment. When fewer than 30% of ≥5 pairs share any segment (e.g. EN sources `/benefits/Disability` vs RU inventory `/Benefits_ru/Nehut_ru/` Hebrew transliterations), the lang is flagged "cross-script" and the title-match "no shared segments → reject" safety rail is disabled for that lang in matchByTitle / matchByTitleSemantic. The ambiguity-gap rejection still applies, so spurious matches are still filtered.
3b. **Pass 1.5 — Alternate-Link Harvest** (`harvestAlternateLinks`): For rows that pattern+crawl couldn't place, fetch each source URL once (concurrency 6, capped at 1500/tab) and extract `<link rel="alternate" hreflang="…">` tags plus `<a hreflang="…">` switcher anchors. Resolved hrefs are validated against the per-lang crawl inventory; only inventory hits become matches (tagged `alternate-link`, confidence 95). This stage runs only on tabs where at least one active lang is flagged cross-script, bounding the HTTP cost. Harvested matches feed back into reference rows for subsequent multi-passes, where `learnTabPatterns` then discovers new segment translations from the harvested pairs. The harvest uses a per-job `AlternateLinkCache` (Map<sourceUrl, parsedAlternates>) shared across passes so identical source URLs are fetched at most once per job. Apply phase gates on per-row needs so that when multiple rows share the same source URL, only rows that actually need a given language can claim that lang's inventory URL — preventing one row from starving its siblings via the global `usedUrls` dedup. Telemetry logged: attempted, fetched, cacheHits, pagesWithAnyAlternate, pagesWithInventoryHit, plus per-lang accepted and rejected-not-in-inventory counts.
4.  **Batch HEAD Verification**: Validates constructed URLs using HTTP HEAD requests (10 concurrent, 12s timeout, 200ms delay between batches), filtering out non-existent or invalid URLs. Source-derived crawl seeds are also generated from all constructed candidates for orphan page discovery.
5.  **Title-Based Matching**: Extracts page titles from `<title>` tags with `<h1>` fallback (for SharePoint sites with empty titles), translates them (Hebrew→EN/FR/RU/AR via GTX), and fuzzy-matches against the crawl inventory with section awareness using Jaccard word overlap. Common site-specific suffixes (e.g., `| ביטוח לאומי`) are stripped for cleaner matching. **Semantic fallback**: rows the Jaccard pass cannot match are scored with OpenAI `text-embedding-3-small` cosine similarity. To get sharp scores, the pipeline pivots through the GTX translation and embeds both the *translated* source title and the inventory titles in the **same** target language (cross-lingual HE↔target embeddings measured at ~0.4 even for true matches; same-language embeddings measured at 0.66–1.00). Reuses all root/depth/ambiguity/URL-segment gates and tags accepted matches as `inventory-title-semantic`. Disabled cleanly when `OPENAI_API_KEY` is absent or `LINGUAMAP_DISABLE_SEMANTIC=1`. Hard cap at 50,000 titles per job to bound cost.
6.  **AI-Powered Matching**: As a final fallback, an AI agent (GPT-5-mini) suggests matches from the crawl inventory for URLs still unmatched, emphasizing accuracy over completeness. The prompt is tuned per active language: examples and pattern context are filtered to active target languages so single-language runs aren't distracted by inactive ones; the "already used" list is sized at 300 per language with all generic index pages always included (preventing the model from re-proposing `/Pages/default.aspx` as a fallback); and a Russian/Arabic addendum tells the model that those URL slugs are Latin transliterations of Hebrew (so the Cyrillic/Arabic page title shown after `  |  ` is the only reliable signal). A per-language summary is logged at the end of the AI stage (attempted, accepted, rejected by reason) for prompt-tuning visibility.

The system supports multi-pass processing, where newly matched URLs in each pass act as additional reference data to refine patterns, improving subsequent matching attempts. Data structures like `TabPatterns` and `RootMapping` store learned patterns and root transformations.

### System Design Choices
-   **Database**: PostgreSQL is used as the primary database for storing job details, mapping results, and translation cache. Drizzle ORM manages schema and interactions.
-   **Concurrency**: Batch HEAD requests and title translations are handled with controlled concurrency and rate limiting.
-   **Error Handling**: AI matching includes retry logic with exponential backoff and early termination for persistent errors.
-   **AI Matching Strategy (Task #55, Apr 2026)**: AI matching shows the model the FULL unused per-language inventory (cap 4000 entries), with same-section candidates listed first as a soft hint rather than a hard filter. Inventory-membership and already-used remain hard rejects; outside-root and section-context checks are hard rejects for EN/FR but warnings only for RU/AR (whose URL slugs are Latin transliterations and frequently break the section-translation map). HEAD-verification of AI picks was removed entirely — picks come from the crawled inventory, so existence is already proven, and re-checking HEAD breaks on sites like BTL that return 4xx for valid pages.
-   **Scalability**: The job-based architecture allows for asynchronous processing, separating long-running tasks from the main request-response cycle.

## External Dependencies

### Required Services
-   **PostgreSQL Database**: Essential for data persistence, managed via the `DATABASE_URL` environment variable.

### Key NPM Packages
-   `drizzle-orm`, `drizzle-kit`: For database interaction and schema management.
-   `xlsx`: For reading and writing Excel files.
-   `multer`: For handling multipart file uploads.
-   `framer-motion`: For client-side animations.
-   `papaparse`: For client-side CSV parsing.
-   `zod`, `drizzle-zod`: For schema validation.
-   `openai`: Used for AI-powered URL matching via Replit AI Integrations.

### External Web Requests
-   HTTP HEAD requests are made to verify the existence of constructed target URLs.
-   Google Translate (GTX endpoint) is used for Hebrew→EN/FR/RU/AR title translations.

### Optional `Seeds` sheet
Workbooks may include an extra sheet named `Seeds` (or `Seed`, case-insensitive) to override the per-tab crawl anchor for any target language. This is useful when the data sheet has zero reference rows for that language (the planner would otherwise skip the tab) or when the auto-derived anchors leak into unrelated sections.

Layout:
- Row 1 = header. Recognized columns: `Tab` (or `Sheet`/`Name`), `EN`, `FR`, `RU`, `AR`. If headers are missing, columns are read positionally as `Tab, EN, FR, RU, AR`.
- One row per data tab. Cells may contain a full URL or a path; both are normalized to a path. Empty cells = no override.

Example:
| Tab | EN | RU |
|---|---|---|
| BTL About | | /RussianHomePage/Odot_ru/ |
| BTL war updates | | /RussianHomePage/Odot_ru/mitsuiZchuyot/IruimBeChaim/HaravotBarzel1/ |

When a `(tab, lang)` cell is filled, that path becomes the **sole** crawl anchor for that tab + language; auto-inferred anchors falling outside it are dropped (no cross-tab leakage), and the "no learned root → skip whole tab" early-return is bypassed. Empty cells fall back to today's auto-derivation. Tab names that don't match any data sheet are warned about and ignored. If the `Seeds` sheet is absent, the workbook works exactly as before.

### Target Languages
The system supports four target languages: English (EN), French (FR), Russian (RU), and Arabic (AR). Source language is always Hebrew. Excel columns: 0=Title, 1=Source, 2=EN, 3=FR, 4=RU, 5=AR. The `TargetLang` type alias (`"en" | "fr" | "ru" | "ar"`) and helper functions (`langRoot`, `langSrcRoot`, `langCrawlScope`, `getResultUrl`, `getResultConf`, `getResultMethod`, `setResultMatch`, `clearResultMatch`, `emptyBatchResult`) centralize language-specific access to pattern data and match results, avoiding duplicated EN/FR ternaries.