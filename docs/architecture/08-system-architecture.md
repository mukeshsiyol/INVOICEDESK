# 08 — System Architecture

## 1. Architectural Style: Modular Monolith

InvoiceDesk adopts a **Modular Monolith** architecture. Given the one-week case study timeline, single-organization operational scope, and strict transactional requirements (atomic PO balance updates coupled with decision persistence), microservices would introduce distributed transaction complexity, network hops, and deployment fragility with zero operational benefit.

Instead, clear **logical module boundaries** inside a single backend service keep the extraction provider, OCR engine, deterministic decision engine, and REST/SSE API layer independently testable and cleanly replaceable.

---

## 2. System Architecture Diagram

```mermaid
flowchart LR
    subgraph Browser["Frontend SPA (React 19 + TypeScript + Vite)"]
        UI[Screens & Design System]
        TQ[TanStack Query Cache]
        PDFJS[PDF.js Viewer]
        SSEClient[EventSource SSE Client]
    end

    subgraph Backend["Backend Modular Monolith (FastAPI + Python 3.12)"]
        API[REST & SSE Router Layer]
        Auth[Auth & RBAC Middleware]
        Orch[Pipeline Orchestrator\nAsyncio Bounded Queue]
        
        subgraph DomainServices["Domain Services"]
            Ingest[Ingestion & Storage Service]
            Extract[Extraction Service\nPDF Text + Tesseract OCR]
            Rules[Deterministic Decision Engine\nDecimal Math]
            Procure[Vendor & PO Service]
            Review[Review & Audit Service]
            Analytics[Analytics Service]
        end

        EventBus[In-Process SSE Broadcaster\nBacked by DB stage_events]
    end

    subgraph External["External / Infrastructure"]
        PG[(PostgreSQL 16\nACID + NUMERIC + JSONB)]
        FS[(Local / Volume Document Storage\nSHA-256 Keyed PDFs)]
        LLM[Configurable LLM Provider\nDefault: Gemini 2.5 Flash]
    end

    UI <-->|JSON over HTTPS| API
    SSEClient <--|SSE /runs/:id/events\nLast-Event-ID Replay| EventBus
    PDFJS <--|Range / Byte Stream| API
    API --> Auth --> DomainServices
    API --> Orch
    Orch --> Ingest & Extract & Rules & Procure
    Orch -->|Persist StageEvent First| PG
    Orch -->|Notify Subscribers| EventBus
    Extract -->|Untrusted Text / Images| LLM
    Ingest <--> FS
    DomainServices <--> PG
```

---

## 3. Existing Repository Inspection & Runtime Alignment Analysis

### 3.1 Current Workspace Baseline
Inspecting the repository (`/` root) shows a clean **Vite + React 19 + TypeScript + Tailwind CSS v4** starter template:
- Present files: `index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`, `metadata.json`, `src/App.tsx` (empty component), `src/main.tsx`, `src/index.css`.
- Installed Node packages: `react`, `react-dom`, `lucide-react`, `motion`, `express`, `tsx`, `@google/genai`, `dotenv`, `tailwindcss`.
- Missing components: No `server.ts`, no Python backend directory, no database schema, and no pre-existing InvoiceDesk domain logic or UI to migrate.

### 3.2 Stack & Runtime Decision (`DEC-01`)
- **Recommended Target Architecture (per Section 11 Specification):**
  - **Frontend:** React + TypeScript + Vite + Tailwind CSS + React Router + TanStack Query + TanStack Table + Recharts + Lucide Icons + PDF.js (`pdfjs-dist`).
  - **Backend:** Python 3.12 + FastAPI + Pydantic v2 + SQLAlchemy 2.0 (async `asyncpg`) + Alembic migrations + `pypdf` / `pypdfium2` + `pytesseract` + `google-genai` SDK.
  - **Database:** PostgreSQL 16.
- **Migration / Runtime Implication for Containerized AI Studio Preview:**
  - If the deployment environment executes strictly via Node.js on port 3000 (`"dev": "tsx server.ts"` with Vite middleware) without a Python/PostgreSQL runtime sidecar, **P1 must confirm runtime availability**:
    - *Path A (Multi-Service / Python-Capable Host):* Vite proxies `/api/*` to FastAPI on port `8000` (or Express proxies `/api/*` to FastAPI) backed by PostgreSQL.
    - *Path B (Node-Only Container Fallback):* Implement the exact same 8-stage modular service boundaries, REST/SSE contracts (`docs/architecture/10-api-specification.md`), and relational schema (`docs/architecture/09-database-design.md`) using TypeScript + Express + `@google/genai` + `pdf-parse` / `tesseract.js` + PostgreSQL/SQLite.
  - Because every domain boundary, API schema, SSE protocol, and SQL model in `docs/architecture/` is language-agnostic at the contract level, either runtime implements the exact same product specification without frontend changes.

---

## 4. Frontend Architecture

| Layer | Technology | Responsibility |
| :--- | :--- | :--- |
| **Build & Routing** | Vite + React 19 + TypeScript + React Router v7 | Code-split routes for all 10 screens; URL query-state sync for filters/pagination. |
| **Server State** | TanStack Query v5 | Caching, background refetch, optimistic UI only for non-critical toggles (never for pipeline progress), query invalidation on SSE `run_completed`. |
| **Live Streaming** | Native `EventSource` wrapper hook (`useRunEventStream`) | Connects to `/api/v1/runs/:runId/events`, handles `Last-Event-ID`, updates TanStack Query cache deterministically as persisted events arrive, auto-reconnects with exponential backoff. |
| **Tables & Charts** | TanStack Table v8 + Recharts | Typed sorting/filtering/selection on Invoices, POs, Vendors, Audit; responsive financial charts with tabular numerals. |
| **PDF Rendering** | `pdfjs-dist` (local worker bundled via Vite) | Client-side canvas rendering of authenticated PDF stream (`/api/v1/invoices/:id/document`), page navigation, zoom, rotation. |
| **Styling** | Tailwind CSS v4 + CSS Design Tokens | Light mode default + `.dark` theme class; zero inline hardcoded colors. |

---

## 5. Backend Service Boundaries

```text
backend/app/
├── main.py                  # FastAPI lifespan, CORS, exception handlers, router mount
├── core/
│   ├── config.py            # Pydantic BaseSettings (env vars only; zero hardcoded secrets)
│   ├── security.py          # Argon2id password hashing, HttpOnly JWT sign/verify, RBAC deps
│   └── logging.py           # Structured JSON logging with request_id & run_id correlation
├── db/
│   ├── session.py           # Async SQLAlchemy engine, session factory, transaction helpers
│   └── models.py            # 12 ORM tables matching 09-database-design.md
├── api/v1/                  # Thin HTTP/SSE controllers (validation + RBAC + DTO mapping)
│   ├── auth.py, invoices.py, runs.py, reviews.py,
│   └── purchase_orders.py, vendors.py, analytics.py, audit.py, settings.py
├── extraction/              # Provider-independent PDF/OCR/LLM boundary
│   ├── base.py              # ExtractionProvider Protocol
│   ├── pdf_reader.py        # pypdf native text + pypdfium2 + pytesseract OCR fallback
│   └── gemini_provider.py   # Gemini structured JSON extractor
├── engine/                  # Pure deterministic finance logic (zero I/O side effects)
│   ├── validator.py         # Stage 3 arithmetic & field completeness
│   ├── vendor_matcher.py    # Stage 4 normalized/alias/fuzzy matching
│   ├── duplicate_checker.py # Stage 5 SHA-256 & normalized business-key check
│   ├── po_matcher.py        # Stage 6 explicit & implied PO matching
│   ├── tolerance.py         # Stage 7 exact Decimal PO balance & tolerance math
│   └── decision_engine.py   # Stage 8 precedence evaluation (R-00..R-16)
└── orchestration/
    ├── pipeline.py          # 8-stage runner + DB persistence + atomic PO commit
    └── sse_broker.py        # Per-run asyncio.Queue fan-out + DB replay on reconnect
```

---

## 6. Processing Orchestration & Live Event Handling

1. **Enqueue (`202 Accepted`):** `POST /api/v1/invoices/upload` writes the PDF safely, creates `Invoice` + `ProcessingRun(status=QUEUED)`, schedules the background task inside an `asyncio.Semaphore(4)` bounded worker pool (preventing OOM during batch OCR), and immediately returns `{ invoice_id, run_id }`.
2. **Persist-Before-Emit Guarantee:** At every stage transition (`STARTED`, `COMPLETED`, `FAILED`), the orchestrator **commits the `StageEvent` row to PostgreSQL first**, assigning a monotonically increasing `sequence_number` (`id`), and *then* pushes the event to `sse_broker.publish(run_id, event)`.
3. **Why No Redis/Celery in v1:** For a single-instance modular monolith handling 1–10 PDFs per upload batch, `asyncio` + PostgreSQL persistence eliminates external broker setup while preserving durability across browser refreshes. If horizontal scaling across multiple worker containers is needed post-v1, `sse_broker` can be swapped to PostgreSQL `LISTEN/NOTIFY` or Redis Pub/Sub behind the same interface.

---

## 7. Document Storage, Logging & Error Handling

- **Document Storage:** Stored on an isolated app directory (`STORAGE_ROOT/invoices/{invoice_uuid}/{sha256}.pdf`) behind an abstract `DocumentStorage` interface (swappable to S3/GCS). Never served directly as static public files—all PDF access routes through RBAC-checked `GET /api/v1/invoices/:id/document` with `Content-Type: application/pdf` and `X-Content-Type-Options: nosniff`.
- **Structured Logging:** Every request and pipeline stage logs JSON with `timestamp`, `level`, `request_id`, `user_id`, `invoice_id`, `run_id`, `stage`, and `duration_ms`. Raw PDF text and API keys are **redacted** from logs.
- **Standardized Error Handling:** FastAPI global exception handlers map domain exceptions (`InvalidPdfError` → `415`, `InsufficientRoleError` → `403`, `ConcurrentReviewConflict` → `409`, `ResourceNotFound` → `404`, `ValidationError` → `422`) into a uniform error envelope:
  ```json
  {
    "error": {
      "code": "CONCURRENT_REVIEW_CONFLICT",
      "message": "This invoice was already resolved by another reviewer.",
      "request_id": "req_9a8b7c",
      "details": {}
    }
  }
  ```
