import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { hashPassword } from './auth.ts';
import { config } from './config.ts';
import { getDb, isoNow } from './db.ts';

// Minimal crisp 5x7 bitmap font for generating genuine image-only scanned PDFs (Edge Case E1)
const FONT_5X7: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '00110', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '$': ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '#': ['01010', '11111', '01010', '01010', '11111', '01010', '00000'],
  '/': ['00001', '00010', '00100', '00100', '01000', '10000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function renderScannedInvoicePng(): Buffer {
  const width = 920;
  const height = 1180;
  const stride = 1 + width; // Grayscale 8-bit
  const raw = Buffer.alloc(stride * height, 248); // off-white paper tone

  // Set filter byte 0 at start of each scanline + subtle paper speckle
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      if ((x * 73 + y * 139) % 211 === 0) {
        raw[y * stride + 1 + x] = 228;
      }
    }
  }

  const drawPixel = (x: number, y: number, shade: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    raw[y * stride + 1 + x] = Math.min(raw[y * stride + 1 + x], shade);
  };

  const drawText = (text: string, startX: number, startY: number, scale = 2, shade = 25, smudge = false) => {
    const upper = text.toUpperCase();
    let cx = startX;
    for (let i = 0; i < upper.length; i++) {
      const glyph = FONT_5X7[upper[i]] ?? FONT_5X7[' '];
      // Simulate slight scanner skew across line
      const skewY = Math.round((cx - startX) * 0.008);
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy][gx] === '1') {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                const px = cx + gx * scale + sx;
                const py = startY + skewY + gy * scale + sy;
                drawPixel(px, py, smudge && i > upper.length - 5 ? 115 : shade);
              }
            }
          }
        }
      }
      cx += 6 * scale;
    }
  };

  // Draw scanned border box & horizontal rules
  for (let x = 40; x < 880; x++) {
    drawPixel(x, 45, 90);
    drawPixel(x, 195, 110);
    drawPixel(x, 420, 110);
    drawPixel(x, 760, 110);
  }

  drawText('NORDIC FREIGHT & LOGISTICS LTD.', 52, 75, 3, 20);
  drawText('OSLO PORT TERMINAL 14, NORWAY', 52, 112, 2, 70);
  drawText('TAX ID: NO-984210554MVA', 52, 140, 2, 70);

  drawText('SCANNED TAX INVOICE', 560, 75, 2, 30);
  drawText('INVOICE NO: NF-88412', 52, 225, 2, 20);
  drawText('INVOICE DATE: 2026-11-10', 52, 255, 2, 20);
  drawText('DUE DATE: 2026-12-10', 52, 285, 2, 20);
  drawText('PO REFERENCE: PO-2026-205', 52, 315, 2, 20);
  drawText('CURRENCY: USD', 52, 345, 2, 20);
  drawText('BILL TO: INVOICEDESK CORP', 490, 225, 2, 40);

  drawText('DESCRIPTION', 52, 445, 2, 30);
  drawText('QTY', 500, 445, 2, 30);
  drawText('UNIT', 600, 445, 2, 30);
  drawText('AMOUNT', 730, 445, 2, 30);

  drawText('OCEAN CONTAINER FREIGHT Q4', 52, 495, 2, 25);
  drawText('2', 500, 495, 2, 25);
  drawText('1750.00', 600, 495, 2, 25);
  drawText('3500.00', 730, 495, 2, 25);

  drawText('CUSTOMS CLEARANCE & PORT FEE', 52, 540, 2, 25);
  drawText('1', 500, 540, 2, 25);
  drawText('700.00', 600, 540, 2, 25);
  drawText('700.00', 730, 540, 2, 25);

  drawText('SUBTOTAL: $4200.00', 540, 795, 2, 25);
  drawText('TAX (EXEMPT): $0.00', 540, 825, 2, 25);
  // Subtle smudge/stamp mark overlapping final total so OCR confidence is visibly affected
  for (let y = 858; y < 892; y++) {
    for (let x = 705; x < 840; x++) {
      if ((x + y) % 3 === 0) drawPixel(x, y, 165);
    }
  }
  drawText('TOTAL DUE: $4200.00', 540, 865, 2, 45, true);
  drawText('STAMPED RECEIVED - SCAN #409', 52, 960, 2, 120);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

async function buildTextInvoicePdf(spec: {
  vendorName: string;
  vendorAddress: string;
  vendorTaxId?: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string;
  poNumber: string | null;
  currency: string;
  lines: Array<{ desc: string; qty: string; unitPrice: string; total: string }>;
  subtotal: string;
  tax: string;
  total: string;
  footerNote?: string;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  let y = 735;
  page.drawText(spec.vendorName, { x: 50, y, size: 18, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
  y -= 18;
  page.drawText(spec.vendorAddress, { x: 50, y, size: 10, font: fontReg, color: rgb(0.35, 0.4, 0.48) });
  if (spec.vendorTaxId) {
    y -= 14;
    page.drawText(`Tax ID: ${spec.vendorTaxId}`, { x: 50, y, size: 10, font: fontReg, color: rgb(0.35, 0.4, 0.48) });
  }

  page.drawText('INVOICE', { x: 470, y: 735, size: 22, font: fontBold, color: rgb(0.15, 0.38, 0.92) });

  y = 655;
  const meta: Array<[string, string]> = [
    ['Invoice Number:', spec.invoiceNumber ?? '(Not Specified)'],
    ['Invoice Date:', spec.invoiceDate],
    ['Due Date:', spec.dueDate],
    ['Purchase Order:', spec.poNumber ?? '(None Listed)'],
    ['Currency:', spec.currency],
  ];
  for (const [k, v] of meta) {
    if (k === 'Invoice Number:' && spec.invoiceNumber === null) continue;
    if (k === 'Purchase Order:' && spec.poNumber === null) continue;
    page.drawText(k, { x: 50, y, size: 10, font: fontBold, color: rgb(0.25, 0.3, 0.38) });
    page.drawText(v, { x: 165, y, size: 10, font: fontReg, color: rgb(0.06, 0.09, 0.16) });
    y -= 16;
  }

  page.drawText('Bill To: InvoiceDesk Operations Inc.', { x: 350, y: 655, size: 10, font: fontBold });
  page.drawText('548 Market St, San Francisco, CA', { x: 350, y: 639, size: 10, font: fontReg });

  y = 535;
  page.drawLine({ start: { x: 50, y: y + 14 }, end: { x: 562, y: y + 14 }, thickness: 1, color: rgb(0.85, 0.88, 0.92) });
  page.drawText('Description', { x: 50, y, size: 10, font: fontBold });
  page.drawText('Qty', { x: 340, y, size: 10, font: fontBold });
  page.drawText('Unit Price', { x: 405, y, size: 10, font: fontBold });
  page.drawText('Line Total', { x: 495, y, size: 10, font: fontBold });
  y -= 10;
  page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: rgb(0.85, 0.88, 0.92) });
  y -= 20;

  for (const line of spec.lines) {
    page.drawText(line.desc, { x: 50, y, size: 10, font: fontReg });
    page.drawText(line.qty, { x: 340, y, size: 10, font: fontReg });
    page.drawText(line.unitPrice, { x: 405, y, size: 10, font: fontReg });
    page.drawText(line.total, { x: 495, y, size: 10, font: fontReg });
    y -= 20;
  }

  y -= 25;
  page.drawLine({ start: { x: 350, y: y + 14 }, end: { x: 562, y: y + 14 }, thickness: 1, color: rgb(0.85, 0.88, 0.92) });
  page.drawText('Subtotal:', { x: 360, y, size: 10, font: fontReg });
  page.drawText(`${spec.currency} ${spec.subtotal}`, { x: 485, y, size: 10, font: fontReg });
  y -= 18;
  page.drawText('Tax:', { x: 360, y, size: 10, font: fontReg });
  page.drawText(`${spec.currency} ${spec.tax}`, { x: 485, y, size: 10, font: fontReg });
  y -= 22;
  page.drawText('Total Amount Due:', { x: 360, y, size: 12, font: fontBold });
  page.drawText(`${spec.currency} ${spec.total}`, { x: 485, y, size: 12, font: fontBold, color: rgb(0.06, 0.09, 0.16) });

  if (spec.footerNote) {
    page.drawText(spec.footerNote, { x: 50, y: 80, size: 9, font: fontReg, color: rgb(0.45, 0.5, 0.58) });
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

export interface DemoFixtureMeta {
  key: string;
  filename: string;
  title: string;
  scenario: string;
  expectedOutcome: string;
}

export const DEMO_FIXTURES: DemoFixtureMeta[] = [
  {
    key: 'happy-path-acme',
    filename: 'acme_cloud_april.pdf',
    title: 'Happy Path — Acme Cloud Services',
    scenario: 'Clean native PDF matching V-001 & PO-2026-104 ($3,450.00 / $15,000.00)',
    expectedOutcome: 'APPROVE (AUTO_APPROVED_MATCH)',
  },
  {
    key: 'e1-scanned-nordic',
    filename: 'nordic_logistics_scan_q3.pdf',
    title: 'E1 — Scanned Image-Only PDF (OCR)',
    scenario: 'Zero native text layer + stamped smudge on total ($4,200.00 on PO-2026-205)',
    expectedOutcome: 'OCR Fallback → APPROVE or REVIEW (Confidence)',
  },
  {
    key: 'e2-duplicate-reissued',
    filename: 'INV-2026-0419_reissued_copy.pdf',
    title: 'E2 — Renamed Duplicate (Different Hash)',
    scenario: 'Same invoice INV 2026-0419 under alias ACME CLOUD INC. (run after Happy Path)',
    expectedOutcome: 'REJECT (DUPLICATE_INVOICE)',
  },
  {
    key: 'e3-split-1',
    filename: 'vertex_milestone_1.pdf',
    title: 'E3 (1/3) — Split PO Milestone #1',
    scenario: 'VS-101 for $4,000.00 against PO-2026-300 ($10,000.00)',
    expectedOutcome: 'APPROVE (Remaining: $6,000.00)',
  },
  {
    key: 'e3-split-2',
    filename: 'vertex_milestone_2.pdf',
    title: 'E3 (2/3) — Split PO Milestone #2',
    scenario: 'VS-102 for $4,000.00 against PO-2026-300 ($6,000.00 remaining)',
    expectedOutcome: 'APPROVE (Remaining: $2,000.00)',
  },
  {
    key: 'e3-split-3',
    filename: 'vertex_milestone_3_overrun.pdf',
    title: 'E3 (3/3) — Split PO Final Overrun',
    scenario: 'VS-103 for $2,250.00 against $2,000.00 remaining ($250 overrun > $10 cap)',
    expectedOutcome: 'REVIEW (TOLERANCE_EXCEEDED)',
  },
  {
    key: 'e4-missing-math-summit',
    filename: 'summit_design_draft.pdf',
    title: 'E4 — Missing Fields & Math Error',
    scenario: 'Missing invoice #, missing PO #, $1,500 + $120 tax != $1,720 total',
    expectedOutcome: 'REVIEW (MISSING_REQUIRED_FIELD + ARITHMETIC_MISMATCH)',
  },
];

export async function ensureDemoFixturesGenerated(): Promise<void> {
  const files: Record<string, () => Promise<Buffer>> = {
    'happy-path-acme.pdf': () =>
      buildTextInvoicePdf({
        vendorName: 'Acme Cloud Services LLC',
        vendorAddress: '100 Spear St, San Francisco, CA 94105',
        vendorTaxId: 'US-94-3829104',
        invoiceNumber: 'INV-2026-0419',
        invoiceDate: '2026-11-12',
        dueDate: '2026-12-12',
        poNumber: 'PO-2026-104',
        currency: 'USD',
        lines: [
          { desc: 'Enterprise Kubernetes Cluster Hosting (Nov)', qty: '1', unitPrice: '2500.00', total: '2500.00' },
          { desc: 'Dedicated VPC Egress & Observability', qty: '1', unitPrice: '694.44', total: '694.44' },
        ],
        subtotal: '3194.44',
        tax: '255.56',
        total: '3450.00',
        footerNote: 'Thank you for your business. Remit via ACH to Acme Cloud Services LLC.',
      }),
    'e1-scanned-nordic.pdf': async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const pngBytes = renderScannedInvoicePng();
      const pngImg = await doc.embedPng(pngBytes);
      page.drawImage(pngImg, { x: 16, y: 20, width: 580, height: 744 });
      return Buffer.from(await doc.save());
    },
    'e2-duplicate-reissued.pdf': () =>
      buildTextInvoicePdf({
        vendorName: 'ACME CLOUD INC.',
        vendorAddress: '100 Spear Street, Suite 400, San Francisco, CA',
        invoiceNumber: 'INV 2026-0419',
        invoiceDate: '2026-11-12',
        dueDate: '2026-12-12',
        poNumber: 'PO-2026-104',
        currency: 'USD',
        lines: [
          { desc: 'Enterprise Kubernetes Cluster Hosting (Nov)', qty: '1', unitPrice: '2500.00', total: '2500.00' },
          { desc: 'Dedicated VPC Egress & Observability', qty: '1', unitPrice: '694.44', total: '694.44' },
        ],
        subtotal: '3194.44',
        tax: '255.56',
        total: '3450.00',
        footerNote: 'RE-ISSUED COPY — Generated from Billing Portal Nov 15, 2026.',
      }),
    'e3-split-1.pdf': () =>
      buildTextInvoicePdf({
        vendorName: 'Vertex Security Partners',
        vendorAddress: '450 Lexington Ave, New York, NY 10017',
        vendorTaxId: 'US-13-7740291',
        invoiceNumber: 'VS-101',
        invoiceDate: '2026-11-01',
        dueDate: '2026-12-01',
        poNumber: 'PO-2026-300',
        currency: 'USD',
        lines: [{ desc: 'SOC2 Type II Penetration Testing — Phase 1 Kickoff (40%)', qty: '1', unitPrice: '4000.00', total: '4000.00' }],
        subtotal: '4000.00',
        tax: '0.00',
        total: '4000.00',
      }),
    'e3-split-2.pdf': () =>
      buildTextInvoicePdf({
        vendorName: 'Vertex Security Partners',
        vendorAddress: '450 Lexington Ave, New York, NY 10017',
        vendorTaxId: 'US-13-7740291',
        invoiceNumber: 'VS-102',
        invoiceDate: '2026-11-08',
        dueDate: '2026-12-08',
        poNumber: 'PO-2026-300',
        currency: 'USD',
        lines: [{ desc: 'Cloud IAM & Infrastructure Audit — Phase 2 Midpoint (40%)', qty: '1', unitPrice: '4000.00', total: '4000.00' }],
        subtotal: '4000.00',
        tax: '0.00',
        total: '4000.00',
      }),
    'e3-split-3.pdf': () =>
      buildTextInvoicePdf({
        vendorName: 'Vertex Security Partners',
        vendorAddress: '450 Lexington Ave, New York, NY 10017',
        vendorTaxId: 'US-13-7740291',
        invoiceNumber: 'VS-103',
        invoiceDate: '2026-11-15',
        dueDate: '2026-12-15',
        poNumber: 'PO-2026-300',
        currency: 'USD',
        lines: [
          { desc: 'Final Remediation Verification & Report Signoff', qty: '1', unitPrice: '2000.00', total: '2000.00' },
          { desc: 'Emergency After-Hours Retest Fee', qty: '1', unitPrice: '250.00', total: '250.00' },
        ],
        subtotal: '2250.00',
        tax: '0.00',
        total: '2250.00',
      }),
    'e4-missing-math-summit.pdf': () =>
      buildTextInvoicePdf({
        vendorName: 'Summit Design Studio',
        vendorAddress: '210 NW 11th Ave, Portland, OR 97209',
        invoiceNumber: null,
        invoiceDate: '2026-11-14',
        dueDate: '2026-12-14',
        poNumber: null,
        currency: 'USD',
        lines: [
          { desc: 'Brand Guidelines Refresh', qty: '1', unitPrice: '1200.00', total: '1200.00' },
          { desc: 'Iconography Kit', qty: '1', unitPrice: '300.00', total: '300.00' },
        ],
        subtotal: '1500.00',
        tax: '120.00',
        total: '1720.00',
        footerNote: 'Draft invoice copy — please process promptly.',
      }),
  };

  for (const [filename, builder] of Object.entries(files)) {
    const dest = path.join(config.fixturesDir, filename);
    try {
      await fs.access(dest);
    } catch {
      const buf = await builder();
      await fs.writeFile(dest, buf);
    }
  }
}

export async function seedInitialDatabase(): Promise<void> {
  const db = getDb();
  const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (userCount > 0) {
    await ensureDemoFixturesGenerated();
    return;
  }

  const now = isoNow();
  const adminId = 'usr-admin-001';
  const reviewerId = 'usr-rev-002';
  const operatorId = 'usr-ops-003';
  const defaultPass = hashPassword('InvoiceDesk2026!');

  db.prepare(
    `INSERT INTO users (id, email, full_name, password_hash, role, theme_preference, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'light', 1, ?, ?)`
  ).run(adminId, 'admin@invoicedesk.io', 'Elena Rostova', defaultPass, 'ADMIN', now, now);

  db.prepare(
    `INSERT INTO users (id, email, full_name, password_hash, role, theme_preference, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'light', 1, ?, ?)`
  ).run(reviewerId, 'reviewer@invoicedesk.io', 'David Park', defaultPass, 'REVIEWER', now, now);

  db.prepare(
    `INSERT INTO users (id, email, full_name, password_hash, role, theme_preference, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'light', 1, ?, ?)`
  ).run(operatorId, 'operator@invoicedesk.io', 'Maya Lin', defaultPass, 'OPERATOR', now, now);

  db.prepare(
    `INSERT INTO application_settings (id, workspace_name, default_currency, max_upload_mb, ocr_min_chars_per_page, force_ocr, tolerance_pct, tolerance_abs, tolerance_mode, confidence_threshold, auto_approve_max_amount, updated_by, updated_at)
     VALUES (1, 'InvoiceDesk', 'USD', 25, 50, 0, '2.00', '10.0000', 'MIN_OF_PCT_AND_ABS', '0.850', '25000.0000', ?, ?)`
  ).run(adminId, now);

  // Vendors V-001 .. V-005
  const vendors = [
    {
      id: 'vnd-001',
      code: 'V-001',
      name: 'Acme Cloud Services LLC',
      norm: 'acme cloud services',
      aliases: ['Acme Cloud Inc.', 'ACME CLOUD INC.', 'Acme Cloud', 'Acme Corp'],
      taxId: 'US-94-3829104',
      status: 'APPROVED',
    },
    {
      id: 'vnd-002',
      code: 'V-002',
      name: 'Nordic Freight & Logistics Ltd.',
      norm: 'nordic freight logistics',
      aliases: ['Nordic Freight', 'Nordic Logistics', 'Nordic Freight & Logistics'],
      taxId: 'NO-984210554MVA',
      status: 'APPROVED',
    },
    {
      id: 'vnd-003',
      code: 'V-003',
      name: 'Vertex Security Partners',
      norm: 'vertex security partners',
      aliases: ['Vertex Security', 'Vertex Partners LLC'],
      taxId: 'US-13-7740291',
      status: 'APPROVED',
    },
    {
      id: 'vnd-004',
      code: 'V-004',
      name: 'Summit Design Studio',
      norm: 'summit design studio',
      aliases: ['Summit Design', 'Summit Studio'],
      taxId: 'US-47-2201948',
      status: 'APPROVED',
    },
    {
      id: 'vnd-005',
      code: 'V-005',
      name: 'Apex Offshore Supply Co.',
      norm: 'apex offshore supply',
      aliases: ['Apex Supply'],
      taxId: 'US-88-0019283',
      status: 'BLOCKED',
    },
  ];

  for (const v of vendors) {
    db.prepare(
      `INSERT INTO vendors (id, vendor_code, canonical_name, normalized_name, aliases, tax_id, default_currency, verification_status, payment_terms_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, 30, ?, ?)`
    ).run(v.id, v.code, v.name, v.norm, JSON.stringify(v.aliases), v.taxId, v.status, now, now);
  }

  // Purchase Orders (PO-2026-104, PO-2026-205, PO-2026-300 kept pristine for live demos + 2 historical POs)
  const pos = [
    {
      id: 'po-104',
      poNumber: 'PO-2026-104',
      normPo: 'PO2026104',
      vendorId: 'vnd-001',
      orig: '15000.0000',
      consumed: '0.0000',
      status: 'OPEN',
      issued: '2026-10-01',
      notes: 'Q4 Cloud Infrastructure & Observability Commitment',
      lines: [
        { num: 1, desc: 'Enterprise Kubernetes Hosting', qty: '4.0000', unit: '2500.0000', tot: '10000.0000' },
        { num: 2, desc: 'VPC Egress & Observability', qty: '1.0000', unit: '5000.0000', tot: '5000.0000' },
      ],
    },
    {
      id: 'po-205',
      poNumber: 'PO-2026-205',
      normPo: 'PO2026205',
      vendorId: 'vnd-002',
      orig: '12500.0000',
      consumed: '0.0000',
      status: 'OPEN',
      issued: '2026-10-15',
      notes: 'Northern Europe Sea & Port Freight Allocation',
      lines: [
        { num: 1, desc: 'Ocean Container Freight', qty: '5.0000', unit: '1750.0000', tot: '8750.0000' },
        { num: 2, desc: 'Customs & Port Handling', qty: '1.0000', unit: '3750.0000', tot: '3750.0000' },
      ],
    },
    {
      id: 'po-300',
      poNumber: 'PO-2026-300',
      normPo: 'PO2026300',
      vendorId: 'vnd-003',
      orig: '10000.0000',
      consumed: '0.0000',
      status: 'OPEN',
      issued: '2026-10-20',
      notes: 'Annual SOC2 Type II Audit & Penetration Testing (Milestone Billing)',
      lines: [
        { num: 1, desc: 'Phase 1 Penetration Test', qty: '1.0000', unit: '4000.0000', tot: '4000.0000' },
        { num: 2, desc: 'Phase 2 Cloud IAM Audit', qty: '1.0000', unit: '4000.0000', tot: '4000.0000' },
        { num: 3, desc: 'Phase 3 Final Signoff', qty: '1.0000', unit: '2000.0000', tot: '2000.0000' },
      ],
    },
    {
      id: 'po-401',
      poNumber: 'PO-2026-401',
      normPo: 'PO2026401',
      vendorId: 'vnd-004',
      orig: '5000.0000',
      consumed: '1500.0000',
      status: 'PARTIALLY_CONSUMED',
      issued: '2026-09-10',
      notes: 'Brand & UI Asset Retainer',
      lines: [{ num: 1, desc: 'Creative Design Services', qty: '1.0000', unit: '5000.0000', tot: '5000.0000' }],
    },
    {
      id: 'po-900',
      poNumber: 'PO-2026-900',
      normPo: 'PO2026900',
      vendorId: 'vnd-001',
      orig: '8400.0000',
      consumed: '8400.0000',
      status: 'CLOSED',
      issued: '2026-08-01',
      notes: 'Completed Q3 Compute Reservation (Closed)',
      lines: [{ num: 1, desc: 'Q3 Compute Reservation', qty: '1.0000', unit: '8400.0000', tot: '8400.0000' }],
    },
  ];

  for (const po of pos) {
    db.prepare(
      `INSERT INTO purchase_orders (id, po_number, normalized_po_number, vendor_id, currency, original_amount, consumed_amount, status, issued_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?)`
    ).run(po.id, po.poNumber, po.normPo, po.vendorId, po.orig, po.consumed, po.status, po.issued, po.notes, now, now);

    for (const l of po.lines) {
      db.prepare(
        `INSERT INTO purchase_order_lines (id, purchase_order_id, line_number, description, quantity, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), po.id, l.num, l.desc, l.qty, l.unit, l.tot);
    }
  }

  await ensureDemoFixturesGenerated();

  // Seed 2 realistic historical invoices (using distinct historical invoice numbers so demo POs remain clean!)
  const seedInvoice = async (opts: {
    invId: string;
    runId: string;
    decId: string;
    filename: string;
    vendorId: string;
    vendorName: string;
    poId: string | null;
    poNumber: string | null;
    invNo: string;
    date: string;
    subtotal: string;
    tax: string;
    total: string;
    outcome: 'APPROVE' | 'REVIEW' | 'REJECT';
    reasonCode: string;
    explanation: string;
    reviewStatus: 'NOT_REQUIRED' | 'PENDING_REVIEW';
    poApplied: number;
    daysAgo: number;
  }) => {
    const createdAt = new Date(Date.now() - opts.daysAgo * 86400_000).toISOString();
    const pdfBuf = await buildTextInvoicePdf({
      vendorName: opts.vendorName,
      vendorAddress: '210 NW 11th Ave, Portland, OR',
      invoiceNumber: opts.invNo,
      invoiceDate: opts.date,
      dueDate: '2026-12-01',
      poNumber: opts.poNumber,
      currency: 'USD',
      lines: [{ desc: 'Historical Baseline Service Period', qty: '1', unitPrice: opts.subtotal, total: opts.subtotal }],
      subtotal: opts.subtotal,
      tax: opts.tax,
      total: opts.total,
    });
    const sha = crypto.createHash('sha256').update(pdfBuf).digest('hex');
    const dir = path.join(config.storageDir, opts.invId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sha}.pdf`), pdfBuf);
    const storageKey = path.relative(config.dataDir, path.join(dir, `${sha}.pdf`));

    db.prepare(
      `INSERT INTO invoices (id, uploaded_by, original_filename, storage_key, file_sha256, file_size_bytes, page_count, document_type, vendor_id, extracted_vendor_name, purchase_order_id, extracted_po_number, invoice_number, normalized_invoice_number, invoice_date, due_date, currency, subtotal_amount, tax_amount, discount_amount, total_amount, overall_confidence, po_consumed_applied, processing_status, business_decision, review_status, latest_run_id, latest_decision_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'INVOICE', ?, ?, ?, ?, ?, ?, ?, '2026-12-01', 'USD', ?, ?, '0.00', ?, 0.9600, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?)`
    ).run(
      opts.invId,
      operatorId,
      opts.filename,
      storageKey,
      sha,
      pdfBuf.length,
      opts.vendorId,
      opts.vendorName,
      opts.poId,
      opts.poNumber,
      opts.invNo,
      opts.invNo.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
      opts.date,
      opts.subtotal,
      opts.tax,
      opts.total,
      opts.poApplied,
      opts.outcome,
      opts.reviewStatus,
      opts.runId,
      opts.decId,
      createdAt,
      createdAt
    );

    db.prepare(
      `INSERT INTO processing_runs (id, invoice_id, run_number, trigger_type, triggered_by, status, current_stage, extraction_mode, started_at, completed_at, duration_ms, created_at)
       VALUES (?, ?, 1, 'INITIAL', ?, 'COMPLETED', 8, 'NATIVE_TEXT', ?, ?, 2410, ?)`
    ).run(opts.runId, opts.invId, operatorId, createdAt, createdAt, createdAt);

    db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, run_id, line_number, description, is_bundled, quantity, unit_price, tax_amount, line_total)
       VALUES (?, ?, ?, 1, 'Historical Baseline Service Period', 0, '1', ?, ?, ?)`
    ).run(crypto.randomUUID(), opts.invId, opts.runId, opts.subtotal, opts.tax, opts.subtotal);

    const stages = [
      'Validated 1-page PDF',
      'Native text extracted · 96% confidence',
      'Decimal arithmetic verified ($0.00 delta)',
      `Matched '${opts.vendorName}' via EXACT_NAME`,
      'No prior duplicates found',
      opts.poNumber ? `Matched ${opts.poNumber}` : 'No open PO match',
      'Balance & tolerance evaluated',
      `Final Decision: ${opts.outcome} (${opts.reasonCode})`,
    ];
    for (let s = 1; s <= 8; s++) {
      db.prepare(
        `INSERT INTO stage_events (run_id, stage_number, stage_code, status, summary, duration_ms, evidence_json, created_at)
         VALUES (?, ?, ?, 'COMPLETED', ?, 300, '{}', ?)`
      ).run(opts.runId, s, `STAGE_${s}`, stages[s - 1], createdAt);
    }

    db.prepare(
      `INSERT INTO decisions (id, run_id, invoice_id, outcome, primary_reason_code, triggered_rules, explanation, evidence_snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`
    ).run(
      opts.decId,
      opts.runId,
      opts.invId,
      opts.outcome,
      opts.reasonCode,
      JSON.stringify([
        {
          rule_id: opts.outcome === 'APPROVE' ? 'R-00' : opts.outcome === 'REJECT' ? 'R-03' : 'R-11',
          reason_code: opts.reasonCode,
          decision: opts.outcome,
          severity: opts.outcome === 'APPROVE' ? 'INFO' : opts.outcome === 'REJECT' ? 'CRITICAL' : 'HIGH',
          message: opts.explanation,
          evidence: {},
        },
      ]),
      opts.explanation,
      createdAt
    );

    db.prepare(
      `INSERT INTO audit_logs (actor_id, actor_type, actor_role, action, resource_type, resource_id, original_decision, new_decision, details_json, created_at)
       VALUES (NULL, 'SYSTEM', 'ENGINE', 'DECISION_GENERATED', 'INVOICE', ?, ?, ?, ?, ?)`
    ).run(
      opts.invId,
      opts.outcome,
      opts.outcome,
      JSON.stringify({ primary_reason_code: opts.reasonCode, explanation: opts.explanation }),
      createdAt
    );
  };

  await seedInvoice({
    invId: 'inv-seed-001',
    runId: 'run-seed-001',
    decId: 'dec-seed-001',
    filename: 'summit_brand_october.pdf',
    vendorId: 'vnd-004',
    vendorName: 'Summit Design Studio',
    poId: 'po-401',
    poNumber: 'PO-2026-401',
    invNo: 'SDS-2026-088',
    date: '2026-11-04',
    subtotal: '1500.00',
    tax: '0.00',
    total: '1500.00',
    outcome: 'APPROVE',
    reasonCode: 'AUTO_APPROVED_MATCH',
    explanation: 'Verified vendor Summit Design Studio, unique invoice, exact arithmetic, and PO-2026-401 balance sufficient.',
    reviewStatus: 'NOT_REQUIRED',
    poApplied: 1,
    daysAgo: 4,
  });

  await seedInvoice({
    invId: 'inv-seed-002',
    runId: 'run-seed-002',
    decId: 'dec-seed-002',
    filename: 'acme_q3_late_charge.pdf',
    vendorId: 'vnd-001',
    vendorName: 'Acme Cloud Services LLC',
    poId: 'po-900',
    poNumber: 'PO-2026-900',
    invNo: 'INV-2026-0311',
    date: '2026-11-09',
    subtotal: '620.00',
    tax: '0.00',
    total: '620.00',
    outcome: 'REJECT',
    reasonCode: 'PO_CLOSED',
    explanation: 'Referenced purchase order PO-2026-900 has status CLOSED and cannot accept new charges.',
    reviewStatus: 'NOT_REQUIRED',
    poApplied: 0,
    daysAgo: 2,
  });

  await seedInvoice({
    invId: 'inv-seed-003',
    runId: 'run-seed-003',
    decId: 'dec-seed-003',
    filename: 'summit_addendum_nov.pdf',
    vendorId: 'vnd-004',
    vendorName: 'Summit Design Studio',
    poId: 'po-401',
    poNumber: 'PO-2026-401',
    invNo: 'SDS-2026-099',
    date: '2026-11-15',
    subtotal: '3850.00',
    tax: '0.00',
    total: '3850.00',
    outcome: 'REVIEW',
    reasonCode: 'TOLERANCE_EXCEEDED',
    explanation: 'Invoice total ($3850.00) exceeds PO-2026-401 remaining balance ($3500.00) by $350.00 (7.00%), surpassing allowed cap ($10.00).',
    reviewStatus: 'PENDING_REVIEW',
    poApplied: 0,
    daysAgo: 1,
  });
}
