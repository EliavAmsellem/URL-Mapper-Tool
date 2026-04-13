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
4.  **Batch HEAD Verification**: Validates constructed URLs using HTTP HEAD requests (10 concurrent, 12s timeout, 200ms delay between batches), filtering out non-existent or invalid URLs. Source-derived crawl seeds are also generated from all constructed candidates for orphan page discovery.
5.  **Title-Based Matching**: Extracts page titles from `<title>` tags with `<h1>` fallback (for SharePoint sites with empty titles), translates them (Hebrew→EN/FR), and fuzzy-matches against the crawl inventory with section awareness. Common site-specific suffixes (e.g., `| ביטוח לאומי`) are stripped for cleaner matching.
6.  **AI-Powered Matching**: As a final fallback, an AI agent (GPT-5-mini) suggests matches from the crawl inventory for URLs still unmatched, emphasizing accuracy over completeness.

The system supports multi-pass processing, where newly matched URLs in each pass act as additional reference data to refine patterns, improving subsequent matching attempts. Data structures like `TabPatterns` and `RootMapping` store learned patterns and root transformations.

### System Design Choices
-   **Database**: PostgreSQL is used as the primary database for storing job details, mapping results, and translation cache. Drizzle ORM manages schema and interactions.
-   **Concurrency**: Batch HEAD requests and title translations are handled with controlled concurrency and rate limiting.
-   **Error Handling**: AI matching includes retry logic with exponential backoff and early termination for persistent errors.
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

### Target Languages
The system supports four target languages: English (EN), French (FR), Russian (RU), and Arabic (AR). Source language is always Hebrew. Excel columns: 0=Title, 1=Source, 2=EN, 3=FR, 4=RU, 5=AR. The `TargetLang` type alias (`"en" | "fr" | "ru" | "ar"`) and helper functions (`langRoot`, `langSrcRoot`, `langCrawlScope`, `getResultUrl`, `getResultConf`, `getResultMethod`, `setResultMatch`, `clearResultMatch`, `emptyBatchResult`) centralize language-specific access to pattern data and match results, avoiding duplicated EN/FR ternaries.