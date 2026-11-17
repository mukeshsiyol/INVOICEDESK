# 02 — User Personas, Jobs-to-be-Done & Permissions

## 1. User Personas

### 1.1 Persona 1: AP Operator — *Maya Lin, Accounts Payable Specialist*
- **Profile:** Processes 40–80 vendor invoices daily. Works at high speed, often handling batches of PDFs received from vendors and internal project managers.
- **Goals:** Upload invoices quickly, confirm extraction succeeded, monitor live runs, spot missing info immediately, and export clean records for end-of-day reconciliation.
- **Frustrations:** Waiting on opaque spinners, manually re-typing 20 line items, or getting blamed when a vendor sends the same invoice twice under a different filename.
- **Primary Screens:** Overview Dashboard, Invoice Upload, Invoice Management, Processing Workspace, Purchase Orders (read-only).

### 1.2 Persona 2: AP Manager / Reviewer — *David Park, Accounts Payable Manager*
- **Profile:** Owns financial accuracy and policy compliance. Does not upload routine invoices; spends time resolving exceptions flagged by automation and answering controller audits.
- **Goals:** Understand *exactly* why an invoice was flagged in under 30 seconds, compare the PDF against PO balances and duplicate evidence side-by-side, and record defensible approval/rejection decisions.
- **Frustrations:** Escalations lacking context, reviewers overriding decisions without leaving notes, and losing track of partial/split invoices eating up a single PO.
- **Primary Screens:** Review Queue, Processing Workspace, Overview Dashboard, Analytics & Reports, Audit Trail.

### 1.3 Persona 3: Administrator — *Elena Rostova, VP of Finance / Systems Admin*
- **Profile:** Configures financial controls, approves vendor onboarding status, manages PO budgets, and maintains audit compliance.
- **Goals:** Tune tolerance thresholds and OCR confidence gates without engineering tickets, manage vendor aliases, govern user roles, and verify audit completeness.
- **Frustrations:** Hardcoded thresholds, shadow spreadsheets, and inability to prove who changed an approval rule or overrode a decision.
- **Primary Screens:** Settings, Vendors, Purchase Orders, Audit Trail, Analytics & Reports, all Workspace screens.

---

## 2. Jobs-to-be-Done (JTBD)

| Role | Situation | Motivation | Expected Outcome |
| :--- | :--- | :--- | :--- |
| **AP Operator** | When a batch of vendor PDFs arrives | I want to upload them and watch automated extraction & matching run live | So that clean invoices auto-approve without manual typing and errors surface immediately |
| **AP Operator** | When an extraction job fails due to an API timeout | I want to retry the run with one click | So that the invoice recovers without re-uploading the PDF |
| **AP Reviewer** | When an invoice lands in the Review Queue | I want to see the PDF, the exact failed rule, and PO/duplicate evidence side-by-side | So that I can approve or reject with a documented note in under a minute |
| **AP Reviewer** | When a vendor splits a PO across 3 invoices | I want to see all prior invoices consumed against that PO | So that I never accidentally approve spend exceeding the original PO commitment |
| **Administrator** | When company policy changes (e.g., tolerance tightened from 5% to 2%) | I want to update rules in Settings and have it audit-logged | So that every subsequent run enforces the new policy deterministically |

---

## 3. Role-Based Access Control (RBAC) Matrix

### 3.1 Screen & Navigation Access

| Screen / Route | AP Operator | AP Manager / Reviewer | Administrator |
| :--- | :---: | :---: | :---: |
| `01` Overview Dashboard (`/`) | View | View | View |
| `02` Invoice Management (`/invoices`) | View + Export | View + Export | View + Export |
| `03` Invoice Upload (`/upload`) | Upload + Run | Upload + Run | Upload + Run |
| `04` Processing Workspace (`/invoices/:id`) | View + Retry | View + Retry + Review Action | View + Retry + Review Action |
| `05` Review Queue (`/reviews`) | View (Read-Only) | View + Decide (Approve/Reject) | View + Decide (Approve/Reject) |
| `06` Purchase Orders (`/purchase-orders`) | View | View + Create/Edit | Full CRUD + Close PO |
| `07` Vendors (`/vendors`) | View | View + Verify Status | Full CRUD + Aliases |
| `08` Analytics & Reports (`/analytics`) | View | View + Export | View + Export |
| `09` Audit Trail (`/audit`) | Denied (Hidden in Nav) | View | View + Export |
| `10` Settings (`/settings`) | Personal Theme Only | Personal Theme Only | Full System Config + Users |

### 3.2 Granular Action & API Permission Matrix

| Permission Scope | Action | Operator | Reviewer | Admin |
| :--- | :--- | :---: | :---: | :---: |
| **Invoices** | `invoice:read` (list, detail, PDF stream, CSV export) | Yes | Yes | Yes |
| **Invoices** | `invoice:upload` (upload PDFs, initiate processing run) | Yes | Yes | Yes |
| **Processing** | `run:retry` (trigger retry on failed/re-run invoice) | Yes | Yes | Yes |
| **Processing** | `run:stream` (subscribe to SSE live stage events) | Yes | Yes | Yes |
| **Reviews** | `review:read` (inspect review queue & evidence) | Yes | Yes | Yes |
| **Reviews** | `review:decide` (approve/reject `REVIEW` invoice + mandatory note) | **No** | Yes | Yes |
| **Reviews** | `review:assign` (assign/claim reviewer on queue item) | **No** | Yes | Yes |
| **Vendors** | `vendor:read` | Yes | Yes | Yes |
| **Vendors** | `vendor:write` (create/update vendor, manage aliases, change verification) | **No** | Verify Only | Yes |
| **Purchase Orders** | `po:read` | Yes | Yes | Yes |
| **Purchase Orders** | `po:write` (create/edit POs, update status) | **No** | **No** | Yes |
| **Analytics** | `analytics:read` | Yes | Yes | Yes |
| **Audit** | `audit:read` (query audit trail) | **No** | Yes | Yes |
| **Settings** | `settings:read` (non-secret thresholds for display) | Yes | Yes | Yes |
| **Settings** | `settings:write` (modify tolerances, confidence threshold, rules) | **No** | **No** | Yes |
| **Users** | `user:manage` (create users, assign roles, deactivate) | **No** | **No** | Yes |

> **Separation of Duties Rule:** Even when an AP Operator uploads an invoice, they **cannot** approve or override a `REVIEW` decision (`HTTP 403 Forbidden`). Reviewers cannot edit system-wide tolerance thresholds (`Settings`) to force an invoice into auto-approval.

---

## 4. Practical Authentication & Session Architecture

To avoid unnecessary enterprise bloat (no SAML/OIDC/SSO in v1) while enforcing real security and supporting effortless 5-minute live demonstrations:

1. **Standard Credential Authentication:**
   - Passwords hashed using `Argon2id` (via `pwdlib` / `argon2-cffi`).
   - Stateless signed JWT access token stored in an **`HttpOnly`, `SameSite=Lax`, `Secure` cookie** (prevents XSS token theft while supporting native `<a href>` / `EventSource` SSE PDF and stream requests without putting tokens in URL query strings).
   - Default session TTL: 12 hours; explicit `POST /api/v1/auth/logout` clears the cookie.
2. **Pre-Seeded Demo Accounts (for Local Dev & Case Study Evaluation):**
   - `admin@invoicedesk.io` (`ADMIN`)
   - `reviewer@invoicedesk.io` (`REVIEWER`)
   - `operator@invoicedesk.io` (`OPERATOR`)
3. **Optional Demo Role Switcher (`APP_ENV=demo` only):**
   - When `ENABLE_DEMO_ROLE_SWITCHER=true` (strictly disabled in `production`), the User Profile menu exposes a "Switch Active Persona" action (`POST /api/v1/auth/demo-switch`) that issues a freshly signed cookie for the selected seeded user and writes an `AUTH_DEMO_SWITCH` audit entry.
   - **Rationale:** During a 5-minute live interview demo, the presenter can upload an invoice as *Operator*, watch it hit `REVIEW`, switch to *Reviewer* in 1 click without losing screen context, and execute the override—proving real RBAC enforcement in the backend (`Operator` gets disabled/403 on approve button; `Reviewer` succeeds).
