# 01 — Product Requirements & Operational Discovery

## 1. Operational Problem Discovery

### 1.1 Current Manual Accounts Payable (AP) Workflow
In a typical mid-market organization receiving 200–1,000+ vendor invoices monthly via email as PDFs, AP operates as a fragile, spreadsheet-driven human assembly line:
1. **Inbox Triage:** An AP clerk downloads PDFs from a shared `ap@company.com` inbox and renames/saves them to a shared drive.
2. **Manual Data Entry:** The clerk opens each PDF side-by-side with an ERP or spreadsheet, reading vendor name, invoice number, dates, line items, taxes, and total.
3. **Vendor & PO Lookup:** The clerk searches an approved vendor sheet and a Purchase Order (PO) ledger to locate the corresponding PO and verify remaining budget.
4. **Mental / Spreadsheet Reconciliation:** The clerk checks line math, compares invoice total against PO remaining balance, applies informal tolerance rules ("is $4 off okay?"), and scans past folders to ensure the invoice was not already paid.
5. **Ad-hoc Escalation:** Exceptions are forwarded over Slack or email to department heads or AP managers without standardized evidence.
6. **Posting & Archiving:** Approved invoices are marked "Paid/Approved" in the ledger, leaving behind scattered email threads as the only audit trail.

### 1.2 Pain Points by Role
- **AP Operators (Clerks):**
  - High cognitive fatigue from repetitive side-by-side transcription across inconsistent vendor PDF templates.
  - Time wasted deciphering scanned, skewed, or multi-page PDFs and hunting down missing PO numbers.
  - Anxiety around silent duplicates (same invoice sent twice by a vendor under `scan_01.pdf` and `INV-8821_revised.pdf`).
- **AP Managers / Reviewers:**
  - Receive vague escalations ("Does this look okay?") lacking side-by-side evidence (PO balance, variance math, extraction confidence).
  - Cannot tell whether an exception is a minor rounding variance ($0.03), an unapproved vendor, or a potential overbilling attempt.
  - Lack visibility into historical overrides and reviewer accountability during audits.

### 1.3 Common Invoice-Processing Failures
1. **Scanned / Image-Only PDFs:** Text copy-paste fails; naive parsers return empty strings.
2. **Layout Heterogeneity:** Vendors place totals, invoice numbers, and tax breakdowns in wildly different positions; taxes may be line-level, summary-level, or embedded.
3. **Missing or Ambiguous Identifiers:** Missing invoice number, missing PO number (implied by vendor + line description), or ambiguous match to multiple open POs.
4. **Arithmetic & Currency Drift:** Subtotal + Tax ≠ Total due to OCR misreads, hidden surcharges, or currency mismatch against the PO (`EUR` invoice billed against `USD` PO).
5. **Split Invoices & Partial Deliveries:** A vendor bills a single $50,000 PO across three monthly milestone invoices; naive 1:1 matching falsely rejects invoices #2 and #3 or fails to track cumulative consumption.
6. **Duplicate Submissions:** Identical vendor + invoice number uploaded under a different filename or slightly re-exported PDF (different SHA-256 file hash).

### 1.4 Financial Risks of Incorrect Approvals
- **Duplicate Payments:** Paying the same invoice twice causes direct cash leakage and costly vendor recovery.
- **Overbilling / PO Overruns:** Approving invoices that exceed remaining PO balance bypasses procurement budget controls.
- **Fraudulent / Unapproved Vendor Payments:** Paying an unverified vendor or mismatched legal entity exposes the company to BEC (Business Email Compromise) fraud.
- **Audit & Compliance Failures:** Approving an invoice without a verifiable trail of *why* a variance was accepted fails SOX / financial audit controls.

### 1.5 Automation vs. Human-in-the-Loop Boundary

| Capability | Where Automation Excels | Where Human Judgment Is Necessary |
| :--- | :--- | :--- |
| **Document Parsing** | Text extraction, OCR, structured field parsing, bounding/snippet evidence capture | Interpreting severely damaged scans or illegible handwritten notes |
| **Math & Reconciliation** | Exact decimal addition, tax checks, cumulative PO balance calculation, duplicate hashing | Deciding whether an out-of-tolerance freight surcharge is commercially acceptable |
| **Policy Enforcement** | Consistent application of tolerance caps, confidence thresholds, and vendor status checks | Granting one-time policy exceptions (e.g., emergency spend on an unapproved vendor) |
| **Auditability** | Recording millisecond-accurate stage logs, rule IDs, and calculation snapshots | Providing business context in mandatory review notes for future auditors |

### 1.6 Information Required to Make a Defensible Decision
A reviewer or automated engine cannot make a defensible decision without seeing:
1. **Original PDF Document** (rendered side-by-side).
2. **Extracted Fields + Field-Level Confidence Scores** (highlighting uncertain OCR reads).
3. **Arithmetic Proof** (`subtotal + tax - discount == total` and sum of lines).
4. **Vendor Verification Status** (matched canonical vendor, alias used, approval status).
5. **Duplicate Check Evidence** (file hash match and/or `(vendor_id, normalized_invoice_number)` match).
6. **PO Reconciliation Proof** (PO original amount, prior approved consumption, current invoice amount, remaining balance, and exact variance `$` and `%`).
7. **Rule-by-Rule Evaluation & Precedence** (every triggered rule code and why `APPROVE`, `REVIEW`, or `REJECT` won).

---

## 2. Product Vision & Problem Statement

- **Product Vision:** Become the trusted operational control plane for mid-market finance teams—turning messy vendor PDFs into instant, deterministic, audit-ready AP decisions in seconds rather than days.
- **Problem Statement:** Finance teams waste hours manually reconciling unstructured vendor PDFs against procurement spreadsheets while risking duplicate payments, PO overruns, and audit gaps. Existing simple OCR tools extract text without enforcing deterministic financial logic, while legacy ERPs hide decision reasoning inside opaque black boxes. InvoiceDesk bridges unstructured AI extraction with deterministic financial verification and full stage-by-stage observability.

---

## 3. Target Users & Core Use Cases

- **Target Users:** Mid-market Finance & Accounting teams (50–1,000 employees) processing 100–5,000 vendor invoices per month.
- **Primary Roles:** Administrator, AP Manager / Reviewer, AP Operator (detailed in [`02-user-personas-and-permissions.md`](./02-user-personas-and-permissions.md)).

### Core Use Cases
1. **UC-01: Single or Batch PDF Upload & Live Execution:** Operator uploads 1+ PDFs and watches the 8-stage pipeline execute in real time via SSE.
2. **UC-02: Straight-Through Processing (Happy Path):** Clean invoice from an approved vendor matches an open PO within tolerance and high confidence → automated `APPROVE`, PO balance decremented atomically.
3. **UC-03: Exception Triage & Human Override:** Invoice flagged `REVIEW` (e.g., OCR low confidence or over-tolerance variance) enters the Review Queue; AP Manager inspects PDF vs. evidence and approves or rejects with mandatory justification notes.
4. **UC-04: Automated Fraud / Error Blocking:** Duplicate invoice or unapproved/mismatched vendor is automatically flagged `REJECT` (or high-severity `REVIEW` per rule matrix) with exact conflicting invoice/vendor evidence.
5. **UC-05: Split-PO Partial Invoicing:** Multiple invoices draw down a single PO sequentially without over-consuming remaining balance.
6. **UC-06: Pipeline Retry & Recovery:** Failed extraction (e.g., transient LLM timeout) is retried from the failed stage or as a new `ProcessingRun` without losing prior run telemetry.
7. **UC-07: Audit & Analytics Inspection:** Controller/Admin inspects approval/review/rejection rates, PO utilization, and immutable override logs.

---

## 4. Functional & Non-Functional Requirements

### 4.1 Functional Requirements

| ID | Requirement | Origin | Priority |
| :--- | :--- | :--- | :--- |
| **FR-01** | Accept real PDF file uploads (single & multi-file drag-and-drop), validate MIME/magic bytes and size (`<= 25 MB`). | Case Study Mandatory | P0/Must |
| **FR-02** | Execute an authentic 8-stage backend pipeline (Ingestion, Extraction, Validation, Vendor Verification, Duplicate Detection, PO Matching, Tolerance Verification, Decision Generation). | Case Study + Spec | P0/Must |
| **FR-03** | Stream live execution stage updates from persisted backend events via SSE; never simulate progress on the client. | Case Study Mandatory | P0/Must |
| **FR-04** | Support both machine-readable PDFs and scanned/image-based PDFs via OCR fallback. | Case Study Mandatory | P0/Must |
| **FR-05** | Extract structured header & line-item data with per-field confidence and source evidence snippets via a provider-independent LLM interface. | Spec | P0/Must |
| **FR-06** | Evaluate deterministic financial rules (`Decimal` arithmetic) producing `APPROVE`, `REVIEW`, or `REJECT` with reason codes and evidence. | Case Study Mandatory | P0/Must |
| **FR-07** | Provide a Split-Screen Processing Workspace (PDF viewer left; extracted fields, confidence, checks, 8-stage timeline right). | Case Study + Spec | P0/Must |
| **FR-08** | Provide an Overview Dashboard with database-derived metrics, trends, decision distribution, PO utilization, and attention queue. | Case Study + Spec | P0/Must |
| **FR-09** | Provide a Review Queue where AP Managers approve/reject `REVIEW` items with mandatory notes while preserving the original automated decision. | Spec | P0/Must |
| **FR-10** | Maintain Vendors (including aliases & verification status) and Purchase Orders (with atomic remaining balance tracking across split invoices). | Case Study + Spec | P0/Must |
| **FR-11** | Maintain an immutable Audit Trail logging system decisions, human overrides, settings changes, and PO/vendor mutations. | Spec | P1/Should |
| **FR-12** | Provide Analytics & Reports with explicit metric formulas, CSV export, and configurable Settings (tolerances, confidence threshold, theme). | Spec | P1/Should |

### 4.2 Non-Functional Requirements

| Category | Target Specification |
| :--- | :--- |
| **Performance** | Machine-readable PDF end-to-end processing `< 8s`; OCR scanned PDF `< 20s`; SSE first event latency `< 500ms`; Dashboard API `< 250ms`. |
| **Accuracy & Financial Integrity** | Zero floating-point arithmetic in monetary comparisons (`NUMERIC(14,4)` in DB, Python `Decimal` in logic). Zero silent fabrication of missing invoice fields. |
| **Reliability & Observability** | Every stage transition persisted to `stage_events` before SSE emit. Idempotent stage execution & `Last-Event-ID` SSE stream recovery. |
| **Security** | Uploaded PDFs treated as untrusted input; prompt injection isolation around LLM extraction; RBAC enforcement on all mutating and sensitive endpoints. |
| **Usability & Accessibility** | Light mode default + Dark mode toggle; WCAG AA contrast; keyboard-navigable tables and review modals; responsive across desktop, tablet, and mobile. |
| **Maintainability** | Modular monolith with strict service boundaries and provider-agnostic `ExtractionProvider` interface. |

---

## 5. Assignment Mandatory Requirements vs. Proposed Enterprise Enhancements

To protect the 1-week case study delivery timeline while meeting enterprise SaaS standards, requirements are explicitly partitioned:

| Category | Mandatory Case Study Requirements | Proposed Enterprise Product Enhancements |
| :--- | :--- | :--- |
| **Core Execution** | Real PDF upload, genuinely executable backend pipeline, live stage-by-stage run view, dashboard with run history/status/outputs. | Multi-run retry history, SSE reconnection replay (`Last-Event-ID`), batch upload queue with pre-upload duplicate hints. |
| **Intelligence & Logic** | Handling clean + scanned PDFs, PO matching, tolerance checks, duplicate detection, 3 clear outcomes (`APPROVE`/`REVIEW`/`REJECT`) with explanations. | Per-field confidence heatmap, bounding/snippet evidence, credit note handling, split-invoice cumulative PO lock (`SELECT FOR UPDATE`). |
| **Edge Cases** | 2–4 realistic, non-trivial edge cases demonstrated live and in 5-min video. | Formalized `E1`–`E4` automated regression test suite + pre-packaged demo fixture PDFs. |
| **Governance & SaaS Polish** | Intuitive UI suitable for live interview walkthrough. | 3-role RBAC matrix, full 10-screen enterprise IA, immutable Audit Trail, Analytics formulas, Light/Dark design system, Settings UI. |

---

## 6. Product Boundaries, Assumptions & Limitations

### 6.1 Product Boundaries (Explicitly Out of Scope for v1)
- **No Direct Bank / ACH Disbursement:** InvoiceDesk produces an approved AP decision ready for ERP posting; it does not initiate wire/ACH payments.
- **No Email Server Polling (IMAP/Webhook):** Invoices enter via web upload UI or REST API (`POST /api/v1/invoices/upload`), not live Gmail/O365 inbox scraping.
- **No Multi-Tenant Organization Isolation:** Single-organization workspace deployment (all users belong to one tenant).
- **No Three-Way Goods Receipt (GRN) Matching:** Matching is two-way (`Invoice ↔ Purchase Order`). Goods Receipt Notes are noted as a P9+ extension.
- **No ERP Bi-directional Sync:** POs and Vendors are seeded and managed inside InvoiceDesk rather than synced live from NetSuite/SAP.

### 6.2 Key Assumptions & Limitations
1. **Currency Handling:** POs and invoices carry explicit ISO-4217 currency codes; cross-currency FX conversion is not performed automatically in v1 (currency mismatch triggers `REVIEW`/`REJECT` per rule `R-11`).
2. **File Format:** Only PDF (`.pdf`, `%PDF-` magic header) is accepted in v1; raw `.png`/`.jpg` uploads are rejected with a clear validation message.
3. **Single-Invoice-Per-PDF Assumption:** Each uploaded PDF represents one primary invoice or credit note document (multi-invoice concatenated PDF packets are out of scope for v1 splitting).
4. **LLM Latency & Availability:** Structured extraction relies on an external LLM API key configured server-side; transient rate limits or timeouts transition `processing_status` to `FAILED` with one-click retry.
