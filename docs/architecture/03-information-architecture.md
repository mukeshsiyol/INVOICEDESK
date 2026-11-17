# 03 — Information Architecture

## 1. Navigation Philosophy

InvoiceDesk follows a **Linear-inspired hierarchical workspace model** paired with **Ramp-style operational clarity**. Every navigation item maps directly to a core AP entity or operational stage—zero filler pages, zero marketing chrome inside the workspace.

---

## 2. Primary Sidebar Hierarchy

The left navigation rail (`240px` expanded / `64px` collapsed on desktop) is organized into four semantic groups:

```text
InvoiceDesk [Workspace Badge]
├── [+ Upload Invoice]  (Primary Global Action CTA)
│
├── WORKSPACE
│   ├── Overview           (/)
│   ├── Invoices           (/invoices)
│   ├── Review Queue       (/reviews)        [Live numeric badge: pending reviews]
│   └── Processing Runs    (/runs)           [Optional filtered view of runs -> or deep-link]
│
├── PROCUREMENT
│   ├── Purchase Orders    (/purchase-orders)
│   └── Vendors            (/vendors)
│
├── INSIGHTS
│   ├── Analytics & Reports (/analytics)
│   └── Audit Trail        (/audit)          [Visible to REVIEWER & ADMIN only]
│
└── ADMINISTRATION
    └── Settings           (/settings)       [Full access ADMIN; Appearance only for others]
```

### 2.1 Note on "Processing Runs" Route
The proposed navigation includes `Processing Runs`. Rather than creating a redundant duplicate table of invoices, `/runs` serves as a dedicated **Execution & Pipeline Log** view listing individual `ProcessingRun` records (`run_id`, `run_number`, `invoice_id`, `trigger_type`: `INITIAL` | `RETRY`, `processing_status`, `started_at`, `duration_ms`, failed stage), clicking any row opens `/invoices/:invoiceId?runId=:runId` inside the **Processing Workspace**. This keeps every navigation destination distinct and purposeful.

---

## 3. Destination Purpose Matrix

| Group | Destination | Route | Primary Purpose |
| :--- | :--- | :--- | :--- |
| **WORKSPACE** | **Overview** | `/` | Real-time executive & operational command center showing DB-derived volume, decision split, PO utilization, recent runs, and items requiring immediate attention. |
| **WORKSPACE** | **Invoices** | `/invoices` | Master searchable/filterable ledger of all ingested invoices with processing status, automated decision, review status, amounts, and CSV export. |
| **WORKSPACE** | **Review Queue** | `/reviews` | Prioritized exception workbench for AP Managers to inspect `REVIEW` invoices, review evidence, and submit mandatory-note Approve/Reject decisions. |
| **WORKSPACE** | **Processing Runs** | `/runs` | Execution-level history across all initial uploads and retries, highlighting currently `RUNNING` SSE streams and `FAILED` stages for rapid triage. |
| **WORKSPACE** | **Invoice Upload** | `/upload` | Dedicated drag-and-drop multi-PDF ingestion queue with client pre-validation, file-hash duplicate warnings, and instant launch into live runs. |
| **WORKSPACE** | **Processing Workspace** | `/invoices/:id` | Hero split-screen screen: PDF viewer (left) + extracted fields, confidence, validation checks, PO math, decision proof, and 8-stage live timeline (right). |
| **PROCUREMENT** | **Purchase Orders** | `/purchase-orders` | PO budget directory tracking original commitment, cumulative consumed amount, remaining balance, PO line items, and linked invoices. |
| **PROCUREMENT** | **Vendors** | `/vendors` | Approved/pending/blocked vendor registry with legal names, tax IDs, aliases used during fuzzy matching, linked POs, and invoice history. |
| **INSIGHTS** | **Analytics & Reports** | `/analytics` | Operational and financial KPIs with transparent metric definitions (approval rate, review rate, avg processing latency, confidence distribution, exception breakdown). |
| **INSIGHTS** | **Audit Trail** | `/audit` | Chronological, immutable compliance log capturing system decisions, human overrides (preserving original decision), and configuration changes. |
| **ADMINISTRATION** | **Settings** | `/settings` | System configuration for tolerances, confidence thresholds, approval policies, OCR/extraction settings, user management, and Light/Dark theme preferences. |

---

## 4. Top Navigation & Persistent Chrome

The top bar (`56px` height, sticky) houses five consistent controls:

1. **Dynamic Breadcrumb Trail (Left):**
   - Root screens show section + page title (e.g., `Workspace / Review Queue`).
   - Detail screens show clickable parent + entity identifier (e.g., `Invoices / INV-2026-0419 · Acme Cloud Services`).
   - On `/invoices/:id`, the breadcrumb row also displays compact status pills: `[Processing: COMPLETED]` and `[Decision: REVIEW]`.
2. **Global Command Search (`Cmd + K` / `Ctrl + K`, Center-Left):**
   - Single keyboard-first search modal querying across:
     - Invoices (by invoice number, filename, extracted vendor name, PO number).
     - Purchase Orders (by PO number, vendor).
     - Vendors (by canonical name or alias).
     - Quick navigation commands ("Go to Review Queue", "Upload Invoice").
   - Backed by `GET /api/v1/search?q=...` with 200ms debounce.
3. **Global Upload Action (`+ Upload Invoice`, Top-Right / Sidebar Top):**
   - Always accessible from anywhere in the app. Navigates to `/upload` or opens the Quick Upload Dropzone modal (if triggered via shortcut `U`), transitioning directly into `/invoices/:id` for a single file or `/runs` / queue summary for batch uploads.
4. **Notifications Bell (Top-Right):**
   - Popover showing real persisted events (derived from recent `stage_events` / `review_actions`):
     - Invoices newly routed to `REVIEW` needing attention.
     - Processing runs that `FAILED`.
     - Concurrency/batch upload completions.
   - Clicking a notification navigates directly to `/invoices/:id`.
5. **Theme Toggle & User Profile Menu (Top-Right):**
   - One-click **Light / Dark** theme toggle (persisted in `localStorage` + user preference).
   - User Avatar + Name + Role badge (`Operator`, `Reviewer`, `Admin`), Demo Persona Switcher (when `APP_ENV=demo`), and Sign Out.

---

## 5. Responsive Navigation Behavior

| Breakpoint | Width | Navigation Behavior |
| :--- | :--- | :--- |
| **Desktop** | `>= 1280px` | Persistent `240px` left sidebar (user-collapsible to `64px` icon rail) + `56px` top bar. |
| **Tablet** | `768px – 1279px` | Default collapsed `64px` icon rail with hover tooltips; expands as overlay on toggle. |
| **Mobile** | `< 768px` | Left sidebar hidden; hamburger button in top bar opens slide-over navigation drawer. Sticky bottom/top `+ Upload` action remains reachable. |

---

## 6. Routing & Deep-Linking Rules

- Every table filter, sort order, pagination page, and active tab is serialized in **URL query parameters** (e.g., `/invoices?decision=REVIEW&sort=-created_at&page=2`) so links can be shared or bookmarked cleanly.
- Detail views use canonical routes:
  - `/invoices/:invoiceId` (defaults to latest `ProcessingRun`)
  - `/invoices/:invoiceId?runId=:runId` (inspects a specific historical run)
  - `/purchase-orders/:poId` (opens PO detail drawer or sub-view)
  - `/vendors/:vendorId` (opens Vendor detail drawer or sub-view)
- Unauthorized role navigation (e.g., an `OPERATOR` manually navigating to `/audit`) renders a clean **403 Access Restricted** empty state with a button back to `/`.
