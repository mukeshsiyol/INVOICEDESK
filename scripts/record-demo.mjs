#!/usr/bin/env node
/**
 * InvoiceDesk Live Browser Demo Recorder
 *
 * Automatically drives a real Chromium browser through the complete
 * InvoiceDesk Accounts Payable workflow and encodes an H.264 MP4 video.
 *
 * Prerequisites (on your local machine):
 *   npm install --no-save playwright && npx playwright install chromium
 *   (optional) ffmpeg in PATH to convert .webm -> .mp4
 *
 * Usage:
 *   DEMO_URL="http://localhost:3000" node scripts/record-demo.mjs
 *   DEMO_URL="https://your-app.onrender.com" node scripts/record-demo.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = (process.env.DEMO_URL || 'http://localhost:3000').replace(/\/+$/, '');
const OUT_DIR = path.resolve(process.cwd(), 'demo-recordings');
const FINAL_MP4 = path.join(OUT_DIR, 'invoicedesk-live-demo.mp4');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPlaywright() {
  const pkg = 'playwright';
  try {
    return await import(pkg);
  } catch {
    console.error(
      [
        'Playwright is not installed in this environment.',
        'Install it locally (without adding it to package.json) via:',
        '  npm install --no-save playwright && npx playwright install chromium',
      ].join('\n')
    );
    process.exit(1);
  }
}

async function runFixtureByTitle(page, titleText, waitSeconds = 16) {
  await page.goto(`${BASE_URL}/upload`, { waitUntil: 'networkidle' });
  await pause(1200);

  const row = page.locator('div', { hasText: titleText }).filter({ has: page.getByRole('button', { name: 'Run Live' }) }).last();
  await row.scrollIntoViewIfNeeded();
  await pause(600);
  await row.getByRole('button', { name: 'Run Live' }).click();

  await page.waitForURL(/\/invoices\/.+/, { timeout: 20_000 });
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText();
    if (/\b(APPROVE|REVIEW|REJECT|FAILED)\b/.test(bodyText) && !/\bRUNNING\b/.test(bodyText)) {
      break;
    }
    await pause(1000);
  }
  await pause(2500);
}

async function main() {
  const { chromium } = await loadPlaywright();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Recording InvoiceDesk live demo against ${BASE_URL} ...`);
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    slowMo: 120,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  const video = page.video();

  try {
    // 1. Overview Dashboard
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await pause(3500);

    // 2. Purchase Orders baseline
    await page.goto(`${BASE_URL}/purchase-orders`, { waitUntil: 'networkidle' });
    await pause(2800);

    // 3. Happy Path live 8-stage execution
    await runFixtureByTitle(page, 'Happy Path — Acme Cloud Services', 22);

    // 4. Edge Case E1: Scanned Image-Only PDF (Vision OCR fallback)
    await runFixtureByTitle(page, 'E1 — Scanned Image-Only PDF (OCR)', 22);

    // 5. Edge Case E2: Renamed Duplicate (Different Hash -> REJECT)
    await runFixtureByTitle(page, 'E2 — Renamed Duplicate (Different Hash)', 20);

    // 6. Edge Case E4: Missing Fields & Math Error
    await runFixtureByTitle(page, 'E4 — Missing Fields & Math Error', 22);

    // 7. Switch Demo Role -> REVIEWER and inspect Exception Review Queue
    const roleBtn = page.locator('header button').filter({ hasText: /OPERATOR|REVIEWER|ADMIN/ }).first();
    if (await roleBtn.isVisible()) {
      await roleBtn.click();
      await pause(600);
      const reviewerChoice = page.getByRole('button', { name: /REVIEWER/i }).first();
      if (await reviewerChoice.isVisible()) {
        await reviewerChoice.click();
        await pause(1000);
      }
    }

    await page.goto(`${BASE_URL}/reviews`, { waitUntil: 'networkidle' });
    await pause(3000);

    // 8. Audit Trail & Dark/Light theme toggle
    await page.goto(`${BASE_URL}/audit`, { waitUntil: 'networkidle' });
    await pause(3000);

    const themeToggle = page.getByRole('button', { name: /Toggle Light\/Dark theme/i });
    if (await themeToggle.isVisible()) {
      await themeToggle.click();
      await pause(2200);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const webmPath = await video?.path();
  if (!webmPath || !fs.existsSync(webmPath)) {
    throw new Error('Playwright did not output a video file.');
  }
  console.log(`Raw WebM saved: ${webmPath}`);

  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        webmPath,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '19',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        FINAL_MP4,
      ],
      { stdio: 'inherit' }
    );
    console.log(`MP4 ready: ${FINAL_MP4}`);
  } catch {
    console.log(`ffmpeg not found or failed — raw video available at: ${webmPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
