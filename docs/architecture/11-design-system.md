# 11 — Design System Specification

## 1. Visual Identity & Philosophy

**InvoiceDesk** blends **Stripe's** typographic precision and calm financial authority, **Linear's** crisp keyboard-first operational density, and **Ramp's** transparent spend-control clarity.

- **Default Theme:** **Light Mode** (clean alabaster canvas `#F8FAFC`, crisp white surfaces `#FFFFFF`, hairline `#E2E8F0` borders).
- **Dark Mode:** Deep slate-obsidian (`#0B0F17` canvas, `#111827` surface, `#1E293B` elevated surface) toggled cleanly via `.dark` root class.
- **Restrained Color Discipline:** Neutral grays carry 90% of the UI. Color is reserved strictly for primary brand actions (`Indigo-Cobalt`) and semantic financial outcomes (`Emerald` = Approve, `Amber` = Review/Warning, `Rose` = Reject/Failed, `Blue` = Running).

---

## 2. Design Tokens (Light & Dark Themes)

### 2.1 Color Tokens

| Token | Light Mode | Dark Mode | Usage |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#F8FAFC` | `#0B0F17` | Main workspace background |
| `--bg-surface` | `#FFFFFF` | `#111827` | Cards, tables, drawers, sidebars |
| `--bg-surface-subtle` | `#F1F5F9` | `#1A2234` | Table headers, hover rows, input fills |
| `--bg-surface-elevated` | `#FFFFFF` | `#1E293B` | Modals, dropdowns, `Cmd+K` palette |
| `--border-default` | `#E2E8F0` | `#1F2937` | Hairline 1px borders & dividers |
| `--border-strong` | `#CBD5E1` | `#334155` | Input borders, focused cards |
| `--text-primary` | `#0F172A` | `#F8FAFC` | Headings, monetary totals, primary labels |
| `--text-secondary` | `#475569` | `#94A3B8` | Metadata, table subtext, descriptions |
| `--text-muted` | `#64748B` | `#64748B` | Timestamps, placeholders, axis labels |
| `--brand-primary` | `#2563EB` | `#3B82F6` | Primary CTAs (`+ Upload`, active nav) |
| `--brand-primary-hover` | `#1D4ED8` | `#60A5FA` | Button hover |
| `--brand-tint` | `#EFF6FF` | `rgba(59,130,246,0.14)` | Active sidebar item, selection tint |

### 2.2 Semantic Decision & Status Tokens

| Outcome / State | Foreground (Light / Dark) | Background (Light / Dark) | Border (Light / Dark) |
| :--- | :--- | :--- | :--- |
| **APPROVE / COMPLETED** | `#047857` / `#34D399` | `#ECFDF5` / `rgba(16,185,129,0.12)` | `#A7F3D0` / `rgba(16,185,129,0.3)` |
| **REVIEW / WARNING** | `#B45309` / `#FBBF24` | `#FFFBEB` / `rgba(245,158,11,0.12)` | `#FDE68A` / `rgba(245,158,11,0.3)` |
| **REJECT / FAILED** | `#BE123C` / `#FB7185` | `#FFF1F2` / `rgba(244,63,94,0.12)` | `#FECDD3` / `rgba(244,63,94,0.3)` |
| **RUNNING / ACTIVE** | `#1D4ED8` / `#60A5FA` | `#EFF6FF` / `rgba(59,130,246,0.14)` | `#BFDBFE` / `rgba(59,130,246,0.35)` |
| **QUEUED / NEUTRAL** | `#475569` / `#94A3B8` | `#F1F5F9` / `#1E293B` | `#E2E8F0` / `#334155` |

### 2.3 Typography Scale
- **UI Sans:** `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`
- **Financial & Code Monospace:** `'JetBrains Mono', ui-monospace, monospace`
- **Mandatory Numeric Rule:** All currency values, PO balances, percentages, timestamps, and durations apply `font-variant-numeric: tabular-nums` so columns align vertically.

| Role | Size / Line-Height | Weight | Tracking |
| :--- | :--- | :--- | :--- |
| Page Title (`H1`) | `22px / 28px` | `600` | `-0.02em` |
| Section Header (`H2`) | `16px / 22px` | `600` | `-0.01em` |
| Card Title (`H3`) | `14px / 20px` | `600` | `0` |
| Body / Table Cell | `13.5px / 20px` | `400` | `0` |
| KPI Hero Figure | `26px / 32px` | `600` | `-0.02em` (`tabular-nums`) |
| Micro Label / Badge | `11.5px / 16px` | `500` | `+0.01em` |

### 2.4 Spacing, Radius, Shadows & Transitions
- **Spacing Scale:** `4px` base grid (`4, 8, 12, 16, 20, 24, 32, 48`). Card padding `20px` (`p-5`), compact operational tables `10px 14px` cell padding.
- **Border Radius:** `--radius-sm: 6px` (badges, inputs, small buttons), `--radius-md: 8px` (cards, dropdowns), `--radius-lg: 12px` (modals, dropzones).
- **Shadows:** Flat hairline borders are preferred over heavy drop shadows; `--shadow-sm: 0 1px 2px rgba(15,23,42,0.04)`, `--shadow-elevated: 0 10px 25px -5px rgba(15,23,42,0.10)`.
- **Transitions:** `150ms cubic-bezier(0.16, 1, 0.3, 1)` for drawers, hover states, and stage node expansions. Respects `prefers-reduced-motion`.

---

## 3. Reusable Component Library Specifications

| Component | Key Variants & Behavioral Rules |
| :--- | :--- |
| **Buttons** | `Primary` (solid brand), `Secondary` (surface + border), `Ghost` (transparent), `Destructive` (rose), `Approve` (emerald). Supports `sm` (`32px`), `md` (`36px`), `loading` spinner state preserving button width. |
| **Inputs & Selects** | `36px` height, `1px` border, clear focus ring (`2px` brand-primary/25%), inline error message slot below input, prefix/suffix slots (e.g., `$` or `%` in Settings). |
| **Dropdowns & `Cmd+K`** | Keyboard navigable (`↑`/`↓`/`Enter`/`Esc`), portal-rendered above overflow containers, instant client or debounced server filtering. |
| **Cards** | `1px` border, `--bg-surface`, optional header row with title + right action slot + subtle divider. |
| **Data Tables** | Powered by TanStack Table: sticky header, sortable column indicators, right-aligned numeric columns, row hover highlight, keyboard focus ring, bulk checkbox selection column. |
| **Badges (3 Distinct Families)** | **1. Processing:** Outlined dot badge (`Running` pulsing dot, `Completed`, `Failed`). **2. Business Decision:** High-contrast tinted pill/tag (`APPROVE`, `REVIEW`, `REJECT`). **3. Review Status:** Subtle bordered tag (`Pending Review`, `Human Approved`, `Human Rejected`). |
| **Modals & Drawers** | Focus-trapped, `Esc` to close, backdrop blur/scrim (`rgba(15,23,42,0.45)`). Modals (`480px–560px`) for confirmations/reviews; Drawers (`520px–680px` slide-over right) for PO and Vendor detail inspection. |
| **8-Stage Timeline** | Vertical connected stepper; active stage displays animated ring; completed stages collapse to 1-line summary + `ms` duration and expand cleanly on click to show structured JSON/table evidence. |
| **Charts (Recharts)** | Custom SVG tooltips styled with `--bg-surface-elevated` and `--border-default`; muted gridlines (`strokeDasharray="3 3"`); accessible colorblind-safe series palette (`#10B981`, `#F59E0B`, `#F43F5E`, `#3B82F6`). |
| **Tooltips** | `200ms` hover/focus delay; max-width `260px`; used heavily on Analytics metric `?` icons to display exact formula & denominator. |
| **Empty / Loading / Error States** | **Loading:** Layout-matched skeletons (never full-page spinners). **Empty:** Centered icon + clear explanation + primary action button. **Error:** Non-destructive inline alert card with exact reason and `Retry` button. |

---

## 4. Responsive Breakpoints

| Breakpoint | Range | Layout Rules |
| :--- | :--- | :--- |
| **Desktop Wide** | `>= 1280px` | Full `240px` sidebar + split-screen Processing Workspace (`48% / 52%`) + 5-col KPI strip. |
| **Tablet / Small Laptop** | `768px – 1279px` | Collapsed `64px` icon sidebar; Processing Workspace stacks split panes if `< 1024px` or narrows to `45% / 55%`; 3+2 KPI grid. |
| **Mobile** | `< 768px` | Drawer sidebar; single-column stacked cards; tables transform to structured summary cards; Processing Workspace uses `[PDF]` / `[Pipeline]` tab switcher. |
