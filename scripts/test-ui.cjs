'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
 const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
 try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
  assert.equal(await page.locator('#browser-warning').isVisible(), true);
  assert.equal(await page.locator('.brand-logo').evaluate(img => img.complete && img.naturalWidth > 0), true);
  assert.equal(await page.locator('#send-form input[type=password]').count(), 0);
  await page.locator('[data-setup=create]').click();
  assert.match(await page.locator('#notification').innerText(), /only in the desktop/);
  assert.equal(await page.locator('#setup-dialog').isVisible(), false);
  await page.locator('.nav-item[data-view=settings]').click();
  assert.equal(await page.locator('#settings-form').isVisible(), true);
  await page.locator('.nav-item[data-view=overview]').click();
  fs.mkdirSync(path.resolve(__dirname, '../artifacts'), { recursive: true });
  await page.screenshot({ path: path.resolve(__dirname, '../artifacts/interface-preview.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('Browser preview: navigation, disabled key operations, responsive layout and no JS errors passed.');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
