import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const targetUrl = process.argv[2] || 'http://localhost:3000';
const label = (process.argv[3] || '').replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '');
const outDir = path.join(process.cwd(), 'temporary screenshots');

fs.mkdirSync(outDir, { recursive: true });

const puppeteer = loadPuppeteer();
const browser = await puppeteer.launch({ headless: 'new' });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  await preparePageForScreenshot(page);
  const file = nextScreenshotPath(outDir, label);
  await page.screenshot({ path: file, fullPage: true });
  console.log(file);
} finally {
  await browser.close();
}

function loadPuppeteer() {
  const candidates = [
    '/Users/filipbara/Documents/Codex/Website building/node_modules/puppeteer',
    path.join(process.cwd(), 'node_modules', 'puppeteer'),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error('Puppeteer nu este instalat in calea configurata sau in node_modules.');
}

async function preparePageForScreenshot(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
    document.querySelectorAll('img[loading="lazy"]').forEach(img => img.setAttribute('loading', 'eager'));
    document.querySelectorAll('iframe[loading="lazy"]').forEach(frame => {
      frame.setAttribute('loading', 'eager');
      if (frame.src) frame.src = frame.src;
    });
    window.scrollTo(0, 0);
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
}

function nextScreenshotPath(dir, suffix) {
  const existing = fs.readdirSync(dir);
  let n = 1;
  while (existing.some(name => name.startsWith(`screenshot-${n}`))) n++;
  return path.join(dir, `screenshot-${n}${suffix ? '-' + suffix : ''}.png`);
}
