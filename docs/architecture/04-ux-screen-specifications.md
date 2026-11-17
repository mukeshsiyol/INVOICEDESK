# 04 — Complete UX Screen Specifications

This document specifies all 10 required screens (plus the `/runs` execution log view) in implementation-ready detail. Every screen binds strictly to persisted backend APIs defined in [`10-api-specification.md`](./10-api-specification.md) and tokens defined in [`11-design-system.md`](./11-design-system.md).

---

## Screen 01 — Overview Dashboard (`/`)

- **Purpose:** Serve as the operational and financial command center showing live, database-derived AP throughput, decision outcomes, pipeline health, PO budget burn, and actionable exceptions.
- **Target User:** All roles (Operator, Reviewer, Admin).
- **Main Layout:**
  - **Header Row:** Page title ("Overview"), date-range selector (`Last 7d`, `Last 30d`, `Last 90d`, `All Time`), quick `+ Upload Invoice` button.
  - **KPI Summary Strip (5 cards across):** Total Invoices Processed, Approved Invoices (count + total `$`), Pending Reviews (count + `$` at risk), Rejected Invoices, Processing Failures.
  - **Middle Analytics Grid (8 / 4 split):**
    - Left (8 cols): **Invoice Volume & Decision Trend** (stacked area/bar chart by day showing `APPROVE`, `REVIEW`, `REJECT`, `FAILED`).
    - Right (4 cols): **Decision Distribution Donut** + exact counts/percentages.
  - **Bottom Operational Grid (6 / 6 split):**
    - Left (6 cols): **Attention Required** list (top `PENDING_REVIEW` and `FAILED` invoices with primary reason code, amount, age, and direct `Inspect` / `Retry` CTA).
    - Right (6 cols): **PO Utilization Snapshot** (top 5 active POs with horizontal stacked progress bar: `Consumed` vs. `Remaining` + **Recent Activity** feed below or tabbed).
- **Components:** `KpiStatCard` (with tabular-nums), `StackedVolumeChart` (Recharts), `DecisionDonutChart` (Recharts), `AttentionQueueList`, `PoUtilizationBarList`, `ActivityTimelineFeed`.
- **Data Requirements:** Aggregated SQL queries over `invoices`, `decisions`, `processing_runs`, `purchase_orders`, and `audit_logs` within the selected time window. Zero hardcoded/mock counters.
- **User Interactions:**
  - Change time range (`7d`/`30d`/`90d`/`all`) updates all KPIs and charts via TanStack Query.
  - Click any KPI card → navigates to `/invoices` pre-filtered by that status/decision.
  - Click an item in Attention Required → opens `/invoices/:id` (Processing Workspace).
  - Click `Retry` on a failed item → triggers `POST /api/v1/invoices/:id/retry` and navigates to `/invoices/:id`.
- **Navigation Behavior:** Root `/` route; sidebar `Overview` active.
- **Loading States:** 5-card shimmer skeleton + rectangular chart placeholders matching exact card heights (zero CLS).
- **Empty States:** First-run state when `total_invoices == 0`: clean onboarding banner ("No invoices processed yet. Upload a sample PDF or your own invoice to watch the 8-stage pipeline run live.") with `+ Upload Invoice` CTA.
- **Error States:** Inline dismissible banner per failed query widget with `Retry Query` button; partial failures do not crash healthy widgets.
- **Mobile Behavior (`< 768px`):** KPI strip stacks 2-up (5th full-width); charts stack 1-column with horizontal scroll hint if needed; Attention Required cards simplify to Vendor, Amount, Badge, and `Inspect` button.
- **API Dependencies:**
  - `GET /api/v1/analytics/overview?window=30d`
  - `GET /api/v1/invoices?attention=true&limit=6`
  - `GET /api/v1/purchase-orders?sort=utilization_desc&limit=5`

---

## Screen 02 — Invoice Management (`/invoices`)

- **Purpose:** Comprehensive, sortable, filterable ledger of every ingested invoice, separating pipeline execution state (`processing_status`), automated outcome (`business_decision`), and human resolution (`review_status`).
- **Target User:** AP Operator (primary), AP Reviewer, Administrator.
- **Main Layout:**
  - **Toolbar:** Search input (`invoice_number`, `vendor`, `po_number`, `filename`), filter dropdowns (`Decision`: All/Approve/Review/Reject, `Processing`: Completed/Running/Failed, `Review`: Pending/Approved/Rejected/Not Required, `Date Range`), `Export CSV` button.
  - **Bulk Action Bar (contextual, appears on row selection):** Selected count + `Export Selected CSV` + `Retry Failed` (for failed items).
  - **Data Table (TanStack Table):** Columns: Checkbox, Invoice # / Filename, Vendor (verified badge), PO #, Invoice Date, Total (tabular-nums + currency), Confidence %, Processing Status, Automated Decision + Reason Code, Review Status, Updated At, Row Actions (`Inspect`, `Download PDF`, `Retry`).
  - **Pagination Footer:** Page size (`20`/`50`/`100`), total count, Prev/Next.
- **Components:** `DataTable`, `FilterChipBar`, `StatusBadge` (3 distinct visual families for Processing, Decision, Review), `ConfidenceBar`, `BulkActionToolbar`, `PaginationBar`.
- **Data Requirements:** Paginated invoice list joined with latest `processing_run`, `decision`, `vendor`, and `purchase_order`.
- **User Interactions:** Live debounced search (300ms), multi-facet filtering synced to URL query params, column sorting, row click → `/invoices/:id`, CSV export via backend stream (`GET /api/v1/invoices/export?...`).
- **Navigation Behavior:** Preserves filter/sort query params when navigating back from `/invoices/:id`.
- **Loading States:** 10-row table skeleton preserving column widths.
- **Empty States:** Differentiates "No invoices uploaded yet" vs. "No invoices match your active filters" (with `Clear All Filters` button).
- **Error States:** Table-scoped error state with `Reload Invoices` action.
- **Mobile Behavior:** Converts table rows into dense summary cards showing Invoice #, Vendor, Total, Automated Decision badge, and Processing Status.
- **API Dependencies:**
  - `GET /api/v1/invoices`
  - `GET /api/v1/invoices/export`
  - `POST /api/v1/invoices/:id/retry`

---

## Screen 03 — Invoice Upload (`/upload`)

- **Purpose:** Reliable, transparent PDF ingestion portal supporting single and multi-file upload, immediate client-side validation, pre-processing duplicate hash warnings, and instant transition to live pipeline execution.
- **Target User:** AP Operator (primary), Reviewer, Admin.
- **Main Layout:**
  - **Dropzone Panel (Top):** Large dashed-border interactive drop target ("Drag & drop vendor invoice PDFs here, or browse files — PDF only, max 25 MB per file, up to 10 files per batch").
  - **Batch Options Bar:** Optional toggle "Auto-start processing immediately" (default `ON`), Optional "Expected PO Hint" (for single-file edge testing, optional).
  - **Upload Queue List (Bottom):** Live table/cards of queued files showing: Filename, File Size, Client SHA-256 Prefix, Validation Status (`Valid PDF` / `Invalid Type` / `Exceeds 25MB`), Pre-Upload Duplicate Check Warning ("Matches previously uploaded file `INV-104.pdf`"), Upload Progress Bar (`%`), Server `run_id` link once accepted.
  - **Action Footer:** `Start Processing` (if auto-start off) / `Open Live Workspace →` (auto-navigates on single file upload; shows per-file `View Live Run` links for batch uploads).
- **Components:** `PdfDropzone`, `UploadQueueItem`, `FileValidationBadge`, `DuplicateHintBanner`, `ProgressBar`.
- **Data Requirements:** Client-side `File` metadata + Web Crypto API SHA-256 pre-check against `POST /api/v1/invoices/precheck-hash` before upload; multipart upload payload.
- **User Interactions:** Drag-and-drop or file picker, remove queued invalid files, inspect pre-upload hash match warning (can still proceed intentionally to test Edge Case E2), click `Upload & Process` or auto-start.
- **Navigation Behavior:** Single file upload automatically routes to `/invoices/:invoiceId?live=true` as soon as `202 Accepted` returns; multi-file upload stays on `/upload` showing real-time mini stage indicators per file via SSE with one-click deep-link into any file's Workspace.
- **Loading States:** Determinate HTTP upload progress bar (`0% → 100%`) followed by "Queued for Stage 1: Ingestion".
- **Empty States:** Clean dropzone with subtle tip listing supported scenarios (clean PDFs, scanned OCR PDFs, credit notes).
- **Error States:** Explicit per-file error messaging: `415 Unsupported Media Type` (non-PDF magic bytes), `413 Payload Too Large` (>25 MB), network drop with `Retry Upload`.
- **Mobile Behavior:** Full-width tap-to-browse button (OS file/PDF picker); simplified single-column queue cards.
- **API Dependencies:**
  - `POST /api/v1/invoices/precheck-hash`
  - `POST /api/v1/invoices/upload`
  - `GET /api/v1/runs/:runId/events` (for batch mini-status)

---

## Screen 04 — Processing Workspace (`/invoices/:id`)

> **Hero Screen:** The centerpiece of InvoiceDesk and the live case study demonstration.

- **Purpose:** Provide complete side-by-side transparency into the original PDF, structured AI extraction with confidence scores, deterministic validation & reconciliation math, the live 8-stage execution timeline, and human review actions.
- **Target User:** All roles (Operator monitors & retries; Reviewer inspects & decides; Admin audits).
- **Main Layout (Full-Height Split-Screen + Top Run Header):**
  - **Workspace Header Bar:**
    - Back link (`← Invoices` or `← Review Queue`), Invoice Title (`INV-2026-0419` or filename while extracting).
    - **Run Selector Dropdown:** Switch between `Run #2 (Latest - RETRY)` and `Run #1 (INITIAL)`.
    - **Three Orthogonal Status Pills:** `Processing: RUNNING | COMPLETED | FAILED`, `Decision: APPROVE | REVIEW | REJECT | PENDING`, `Review: PENDING_REVIEW | OVERRIDDEN_APPROVED | ...`.
    - **Action Buttons:** `Retry Run` (when failed or admin re-eval), `Approve` / `Reject` (enabled for `REVIEWER`/`ADMIN` when `review_status == PENDING_REVIEW`), `Download PDF`.
  - **Left Pane (48% width on desktop, sticky):**
    - **PDF Viewer (PDF.js):** Toolbar with Page `1 / N` Prev/Next, Zoom (`-`, `100%`, `+`, `Fit Width`), Rotate CW, Download, and OCR Layer Toggle ("View Raw Extracted Text / OCR Overlay" modal/drawer for E1 demonstration).
  - **Right Pane (52% width on desktop, scrollable with pinned Decision Banner):**
    1. **Decision Explanation Banner (Top):** High-clarity card displaying the outcome (`APPROVE` / `REVIEW` / `REJECT`), primary `reason_code`, plain-English explanation, triggered rule IDs, and if overridden by a human, **both** the preserved `Original Automated Decision` and the `Human Override` block.
    2. **8-Stage Live Execution Timeline (Collapsible/Always-Visible Stepper):**
       - Lists Stages `1`–`8` (`Ingestion` → `Extraction` → `Validation` → `Vendor Verification` → `Duplicate Detection` → `PO Matching` → `Tolerance Verification` → `Decision Generation`).
       - Each stage row shows: Status icon (`Pending`, `Running` spinner, `Success` check, `Warning`, `Failed` X), Stage Name, Duration (`ms`), one-line summary.
       - Expanding any stage reveals **Persisted Stage Evidence JSON / structured breakdown** (e.g., OCR page count, regex matches, candidate POs evaluated).
       - Failed stage shows exact error code/message + inline `Retry from Failed Stage` / `Re-run Pipeline` button.
    3. **Tabbed Structured Inspection Panels:**
       - **Tab 1 — Extracted Data & Line Items:** Header fields (`Vendor`, `Invoice #`, `Date`, `Due Date`, `PO #`, `Currency`, `Subtotal`, `Tax`, `Total`, `Document Type`) each paired with a **Confidence Pill** (`98%` green / `74%` amber / `Missing` red) and hover/click **Source Evidence Snippet**. Followed by the **Line Items Table** (`#`, `Description`, `Qty`, `Unit Price`, `Tax`, `Line Total`).
       - **Tab 2 — Verification & Reconciliation Proof:**
         - *Arithmetic Check Card:* Sum of lines vs. Subtotal; `Subtotal + Tax - Discount == Total` exact `Decimal` equation.
         - *Vendor Verification Card:* Extracted name → Matched Canonical Vendor, match method (`EXACT` / `ALIAS` / `FUZZY`), vendor status (`APPROVED` / `UNVERIFIED` / `BLOCKED`).
         - *Duplicate Detection Card:* Content SHA-256 check + `(vendor_id, normalized_invoice_number)` check + clickable link to conflicting invoice if found.
         - *PO Matching & Tolerance Card:* Matched PO #, PO Original Amount, Prior Approved Invoices (clickable list), Current Invoice Amount, Remaining Balance After Invoice, Variance (`$` and `%`), Policy Threshold (`min(2%, $10)`), Pass/Fail result.
       - **Tab 3 — Audit & Review History:** Run-specific review actions and audit events for this invoice.
- **Components:** `PdfJsViewer`, `RunSelector`, `OrthogonalStatusBar`, `DecisionBanner`, `EightStageTimeline`, `ConfidenceFieldGrid`, `LineItemsTable`, `ReconciliationProofPanel`, `ReviewActionModal`.
- **Data Requirements:** Invoice detail payload + active `ProcessingRun` + `StageEvent[]` + `Decision` + `InvoiceLine[]` + `PoMatchSnapshot` + `ReviewAction[]` + live SSE subscription while `processing_status` is `QUEUED` or `RUNNING`.
- **User Interactions:** Real-time SSE updates without page refresh; expand/collapse stage evidence; inspect raw OCR text vs. PDF visual; switch historical runs; open Approve/Reject review modal (with mandatory note validation >= 10 chars); trigger retry.
- **Navigation Behavior:** Deep-linkable `?runId=...&tab=reconciliation`. Closing or refreshing mid-run seamlessly reconnects SSE using `Last-Event-ID` and replays missed stages from DB.
- **Loading States:** Left PDF pane shows document skeleton; right pane shows timeline with Stages 1–8 in `QUEUED` state until SSE events arrive.
- **Empty States:** While Stage 2 (`Extraction`) is still running, Extracted Data fields display subtle "Extracting structured fields..." placeholders rather than fake zeros.
- **Error States:** PDF render failure offers `Download Original PDF` fallback; SSE disconnect displays subtle "Reconnecting live stream..." badge with exponential backoff and automatic REST state resync.
- **Mobile Behavior:** Split-screen switches to a top segmented tab toggle: `[Document PDF]` vs. `[Pipeline & Extraction]`, keeping the Decision Banner and Approve/Reject bar pinned.
- **API Dependencies:**
  - `GET /api/v1/invoices/:id`
  - `GET /api/v1/invoices/:id/document` (PDF byte stream)
  - `GET /api/v1/runs/:runId`
  - `GET /api/v1/runs/:runId/events` (SSE)
  - `POST /api/v1/invoices/:id/retry`
  - `POST /api/v1/invoices/:id/review`

---

## Screen 05 — Review Queue (`/reviews`)

- **Purpose:** Focused exception-resolution workbench enabling AP Managers to triage, claim, inspect, and resolve `PENDING_REVIEW` invoices without digging through auto-approved noise.
- **Target User:** AP Manager / Reviewer (primary), Admin (read/decide), Operator (read-only).
- **Main Layout:**
  - **Category Filter Tabs:** `All Pending (N)`, `High Severity / Variance`, `Missing / Low Confidence`, `Vendor / PO Ambiguity`, `Resolved History`.
  - **Split or Drawer-Assisted Queue Layout:**
    - Left/Main: Prioritized Queue Table (`Priority` High/Med/Low, `Invoice #`, `Vendor`, `Amount`, `Primary Exception Reason Code`, `Assigned Reviewer`, `Age in Queue`).
    - Right Quick-Inspect Drawer (on row click, with `Open Full Workspace →` link): Shows PDF thumbnail/preview, failed rule explanation, PO variance math, and inline **Approve / Reject** panel with **mandatory Reviewer Note** textarea.
- **Components:** `QueueCategoryTabs`, `PriorityBadge`, `AssigneeSelector`, `ExceptionEvidenceCard`, `ReviewDecisionForm` (enforces non-empty justification note), `ReviewHistoryTable`.
- **Data Requirements:** Invoices where `review_status == PENDING_REVIEW` (or resolved items for History tab), ordered by severity + SLA age.
- **User Interactions:** Assign/claim to self (`POST /api/v1/reviews/:invoiceId/assign`), filter by exception category, submit `APPROVE` or `REJECT` with mandatory notes (`>= 10` characters), view resolved history showing `Original Decision: REVIEW` alongside `Override: APPROVED/REJECTED`.
- **Navigation Behavior:** Clicking `Open Full Workspace` routes to `/invoices/:id`; submitting a decision removes item from Pending tab and updates sidebar badge count.
- **Loading States:** Queue table + drawer skeleton.
- **Empty States:** Celebratory clean operational state: "Review Queue Clear — All flagged exceptions have been resolved."
- **Error States:** Concurrent modification conflict (`409 Conflict` if another reviewer already decided the item) alerts the user and refreshes the queue.
- **Mobile Behavior:** Full-screen queue cards; tapping a card opens a bottom sheet/full-page detail with Approve/Reject actions.
- **API Dependencies:**
  - `GET /api/v1/reviews?status=PENDING_REVIEW&category=...`
  - `POST /api/v1/reviews/:invoiceId/assign`
  - `POST /api/v1/invoices/:id/review`

---

## Screen 06 — Purchase Orders (`/purchase-orders`)

- **Purpose:** Authoritative procurement budget ledger tracking PO original amounts, cumulative approved invoice consumption (including split invoices), remaining balances, line items, and PO lifecycle status.
- **Target User:** All roles (read); Admin (create/edit/close).
- **Main Layout:**
  - **Header + Toolbar:** Search (`PO #`, `Vendor`), Status filter (`OPEN`, `PARTIALLY_CONSUMED`, `FULLY_CONSUMED`, `CLOSED`), `+ Create PO` button (Admin only).
  - **PO Table:** `PO Number`, `Vendor`, `Currency`, `Original Amount`, `Consumed Amount`, `Remaining Balance`, `Utilization %` (progress bar), `Status`, `Linked Invoices Count`.
  - **PO Detail Slide-Over Drawer (on row click):**
    - PO Metadata + financial summary (`Original - Consumed = Remaining`).
    - **PO Line Items Table** (`Line #`, `Description`, `Qty`, `Unit Price`, `Total`).
    - **Associated Invoices Table** (every invoice matched to this PO, showing its status, consumed amount, and link to `/invoices/:id`).
- **Components:** `PoDirectoryTable`, `UtilizationProgressBar`, `PoDetailDrawer`, `PoLineItemsTable`, `LinkedInvoicesList`, `CreatePoModal` (Admin).
- **Data Requirements:** `purchase_orders` joined with `vendors`, `purchase_order_lines`, and approved/matched `invoices`.
- **User Interactions:** Filter/search POs, open detail drawer to audit split-invoice drawdown (Edge Case E3), Admin creates or closes PO (`PATCH /api/v1/purchase-orders/:id`).
- **Navigation Behavior:** Clicking a linked invoice navigates to `/invoices/:id`; deep-linkable `/purchase-orders/:poId`.
- **Loading States:** Table row skeletons + drawer spinner.
- **Empty States:** "No Purchase Orders found." (with `+ Create PO` for Admin).
- **Error States:** Validation error if Admin tries to close a PO or reduce PO amount below already-consumed amount (`422 Unprocessable Entity`).
- **Mobile Behavior:** Summary cards with Utilization bar; tapping opens full-screen detail sheet.
- **API Dependencies:**
  - `GET /api/v1/purchase-orders`
  - `GET /api/v1/purchase-orders/:id`
  - `POST /api/v1/purchase-orders` (Admin)
  - `PATCH /api/v1/purchase-orders/:id` (Admin)

---

## Screen 07 — Vendors (`/vendors`)

- **Purpose:** Manage approved vendor master data, legal names, aliases (critical for messy invoice headers), tax IDs, verification status, and historical spend/exceptions.
- **Target User:** All roles (read); Reviewer (verify); Admin (full CRUD + aliases).
- **Main Layout:**
  - **Header + Toolbar:** Search (`Vendor Name`, `Alias`, `Tax ID`), Verification filter (`APPROVED`, `UNVERIFIED`, `BLOCKED`), `+ Add Vendor` (Admin).
  - **Vendor Directory Table:** `Canonical Name`, `Aliases Count`, `Tax ID`, `Default Currency`, `Verification Status`, `Open POs`, `Total Invoices`, `Exception Rate %`.
  - **Vendor Profile Drawer (on row click):**
    - Profile summary + editable **Aliases Tag List** (e.g., `["Acme Cloud Inc.", "ACME CLOUD", "Acme Corp"]`).
    - Verification status control (Admin/Reviewer).
    - Tabbed `Associated POs` and `Invoice History`.
- **Components:** `VendorTable`, `VerificationStatusBadge`, `AliasTagEditor`, `VendorProfileDrawer`.
- **Data Requirements:** `vendors` with aggregated PO count, invoice count, and rejection/review rate.
- **User Interactions:** Inspect aliases explaining why an invoice matched a vendor; Admin adds alias or changes status from `UNVERIFIED` to `APPROVED` (with audit log).
- **Navigation Behavior:** Deep-linkable `/vendors/:vendorId`; linked POs/invoices route directly to their respective screens.
- **Loading States:** Table & drawer skeletons.
- **Empty States:** "No vendors match your search."
- **Error States:** Duplicate Tax ID or conflicting alias warning (`409 Conflict`).
- **Mobile Behavior:** Card list showing Vendor Name, Verification Badge, Open POs, Invoice Count.
- **API Dependencies:**
  - `GET /api/v1/vendors`
  - `GET /api/v1/vendors/:id`
  - `POST /api/v1/vendors` (Admin)
  - `PATCH /api/v1/vendors/:id` (Admin/Reviewer)

---

## Screen 08 — Analytics & Reports (`/analytics`)

- **Purpose:** Quantify AP automation performance, accuracy, latency, exception drivers, and PO consumption using transparent, documented database formulas.
- **Target User:** AP Manager / Reviewer, Admin, Operator (read).
- **Main Layout:**
  - **Controls Header:** Date window selector (`7d`, `30d`, `90d`, `All`), Vendor filter, `Export Summary CSV`.
  - **7 Metric Cards (each with `?` Info Tooltip displaying the exact formula & denominator):**
    1. **Automated Approval Rate**
    2. **Human Review Rate**
    3. **Rejection Rate**
    4. **Median & P95 Processing Time**
    5. **Mean Extraction Confidence**
    6. **Straight-Through Processing (STP) Accuracy / Override Rate**
    7. **Aggregate PO Utilization**
  - **Charts Grid (2x2):**
    - **Exception Distribution Bar Chart:** Counts by `reason_code` (`TOLERANCE_EXCEEDED`, `DUPLICATE_INVOICE`, `LOW_CONFIDENCE`, `MISSING_REQUIRED_FIELD`, etc.).
    - **Processing Time by Stage / Path:** Machine-readable vs. OCR scanned latency breakdown.
    - **Extraction Confidence Histogram:** Distribution across `0–60%`, `60–80%`, `80–90%`, `90–100%`.
    - **PO Utilization Breakdown:** Consumed vs. Remaining across top vendors/POs.

### Explicit Metric Formulas & Denominators

| Metric | Numerator | Denominator | Notes |
| :--- | :--- | :--- | :--- |
| **Approval Rate** | Count of invoices whose latest automated decision is `APPROVE` | Total invoices with a completed `Decision` (`APPROVE + REVIEW + REJECT`) in window | Excludes `FAILED` / in-flight runs from denominator so failures don't distort policy rates. |
| **Review Rate** | Count of invoices whose latest automated decision is `REVIEW` | Total invoices with a completed `Decision` in window | Measures exception rate requiring human touch. |
| **Rejection Rate** | Count of invoices whose latest automated decision is `REJECT` | Total invoices with a completed `Decision` in window | Includes automated policy rejections (e.g., duplicates, blocked vendors). |
| **Processing Time (Median / Avg)** | `duration_ms` of latest `COMPLETED` `ProcessingRun` (`completed_at - started_at`) | Total `COMPLETED` `ProcessingRun` records in window | Reported both overall and segmented by `extraction_mode` (`TEXT` vs. `OCR`). |
| **Mean Extraction Confidence** | Sum of `overall_confidence` (`0.00–1.00`) across completed extractions | Total completed extractions in window | Computed from the weighted mean of required header field confidences. |
| **Exception Distribution** | Count of triggered rules grouped by primary `reason_code` | Total `REVIEW` + `REJECT` decisions in window | Identifies top operational bottlenecks (e.g., missing POs vs. OCR quality). |
| **PO Utilization** | Sum of `consumed_amount` across non-cancelled POs | Sum of `original_amount` across non-cancelled POs | Uses `NUMERIC(14,4)` sums; displayed as percentage (`consumed / original * 100`). |

- **Loading / Empty / Error / Mobile:** Skeleton cards & chart boxes; empty chart message when no runs exist in date range; 1-column chart stack on mobile.
- **API Dependencies:**
  - `GET /api/v1/analytics/metrics?window=30d&vendorId=...`
  - `GET /api/v1/analytics/export?window=30d`

---

## Screen 09 — Audit Trail (`/audit`)

- **Purpose:** Provide an immutable, filterable compliance ledger of every automated decision, human review override (explicitly preserving the original automated outcome), vendor/PO mutation, and configuration change.
- **Target User:** AP Manager / Reviewer, Administrator (hidden/403 for Operator).
- **Main Layout:**
  - **Filter Bar:** Search (actor email, resource ID, note text), `Action Type` (`DECISION_GENERATED`, `REVIEW_OVERRIDE_APPROVED`, `REVIEW_OVERRIDE_REJECTED`, `RUN_RETRIED`, `SETTINGS_UPDATED`, `VENDOR_UPDATED`, `PO_CREATED`), `Resource Type`, `Date Range`, `Export Audit CSV`.
  - **Audit Log Table:** `Timestamp (UTC + Local)`, `Actor (User + Role or SYSTEM_ENGINE)`, `Action`, `Affected Resource (clickable link)`, `Original Decision`, `New / Override Decision`, `Summary / Mandatory Note`, `Expand Details`.
  - **Expandable Row Diff:** Shows structured JSON `before_state` / `after_state` and `evidence_snapshot`.
- **Components:** `AuditFilterBar`, `AuditLogTable`, `DecisionDeltaBadge` (`REVIEW → APPROVED`), `JsonDiffViewer`.
- **Data Requirements:** Append-only `audit_logs` table ordered by `created_at DESC` with keyset or offset pagination.
- **User Interactions:** Expand row to inspect full before/after JSON diff; click resource ID to jump directly to `/invoices/:id` or `/purchase-orders/:id`.
- **Loading / Empty / Error / Mobile:** Table skeleton; empty search state; mobile cards showing Timestamp, Actor, Action badge, and Decision Delta.
- **API Dependencies:**
  - `GET /api/v1/audit-logs`
  - `GET /api/v1/audit-logs/export`

---

## Screen 10 — Settings (`/settings`)

- **Purpose:** Centralize system-wide financial control parameters, extraction/OCR settings, user role management, and personal appearance preferences.
- **Target User:** Administrator (full edit); Operator & Reviewer (Appearance tab only; system policy tabs read-only with lock indicator).
- **Main Layout (Left Vertical Sub-Nav + Right Form Panel):**
  1. **General:** Workspace name, default company currency (`USD`), fiscal date format.
  2. **Processing Configuration:** Max upload size (`25 MB`), OCR fallback toggle (`Always auto-fallback` vs. `Force OCR`), minimum text chars/page threshold (`50 chars`), active LLM extraction model display (read-only/env-bound, no API key inputs!).
  3. **Approval Rules & Tolerance:**
     - Percentage tolerance threshold (default `2.00%`).
     - Absolute dollar tolerance cap (default `$10.00`).
     - Tolerance combination mode (`MIN_OF_PCT_AND_ABS` recommended default vs. `MAX` vs. `PCT_ONLY`).
     - Auto-approve ceiling amount (optional safety cap, e.g., invoices `> $25,000` always require human `REVIEW`).
  4. **Confidence Threshold:** Minimum field confidence gate (default `0.85` / `85%`) below which invoices route to `REVIEW`.
  5. **Notifications:** Toggle in-app alerts for `REVIEW` arrivals and `FAILED` runs.
  6. **Security & Users (Admin Only):** Active users table, invite/create user, role assignment (`OPERATOR`, `REVIEWER`, `ADMIN`), deactivate user, session TTL info.
  7. **Appearance (All Roles):** Theme selector (`Light` [default] / `Dark` / `System`), table density (`Comfortable` / `Compact`).
- **Components:** `SettingsSubNav`, `ToleranceRuleForm`, `SliderNumberInput`, `UsersManagementTable`, `ThemeSelectorCards`, `SaveChangesBar`.
- **Data Requirements:** `application_settings` singleton/versioned config row + `users` list (Admin).
- **User Interactions:** Edit numeric thresholds with inline validation (`0 <= tolerance_pct <= 25`), click `Save Policy` → writes new settings + immutable `SETTINGS_UPDATED` audit log entry. Theme switches instantaneously via CSS class `.dark`.
- **Loading / Empty / Error / Mobile:** Form skeletons; validation errors inline under fields; sub-nav converts to horizontal scrollable tabs on mobile.
- **API Dependencies:**
  - `GET /api/v1/settings`
  - `PATCH /api/v1/settings` (Admin)
  - `GET /api/v1/users` (Admin)
  - `POST /api/v1/users` / `PATCH /api/v1/users/:id` (Admin)

---

## Supplemental View — Processing Runs (`/runs`)

- **Purpose:** Pipeline-centric execution monitor ordered by `started_at DESC`, allowing operators to watch active `RUNNING` streams, inspect retry attempts (`Run #1`, `Run #2`), and spot `FAILED` stages at a glance.
- **Target User:** AP Operator, AP Manager, Admin.
- **Layout & Data:** Table showing `Run ID`, `Invoice # / Filename`, `Run # & Trigger (INITIAL / RETRY)`, `Current Stage (1–8)`, `Processing Status`, `Duration`, `Extraction Mode (TEXT / OCR)`, `Started At`. Clicking any row navigates to `/invoices/:invoiceId?runId=:runId`.
- **API Dependency:** `GET /api/v1/runs`.
