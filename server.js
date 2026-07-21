// server.js
// 상세페이지 고화질 캡쳐 웹앱 서버
//
// 무료 호스팅(Render 등) 환경은 메모리가 작기 때문에(보통 512MB),
// 아래 세 가지를 신경써서 만들었음:
//  1. 동시에 한 번에 1개 캡쳐만 처리 (여러 명이 동시에 눌러도 줄 세워서 순서대로 처리)
//  2. 해상도 배율(scale) 상한을 2.5로 제한 (너무 올리면 메모리 부족으로 서버가 죽을 수 있음)
//  3. 캡쳐 끝나면 브라우저 컨텍스트를 바로 닫아서 메모리 회수

import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 서버 시작 시 public 폴더 내용 디버깅용 로그
const publicPath = path.join(__dirname, 'public');
try {
  const publicFiles = fs.readdirSync(publicPath);
  console.log('[DEBUG] public 폴더 파일 목록:', publicFiles);
} catch (err) {
  console.error('[DEBUG] public 폴더 읽기 실패:', err);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const MAX_SCALE = 2.5; // 무료 서버 메모리 보호용 상한
const MAX_HEIGHT = 15000; // 메모리 보호용 최대 캡쳐 높이 (px)

let browser; // 브라우저는 한 번만 켜두고 재사용 (매번 켜면 느리고 무거움)
let isBusy = false; // 동시에 여러 캡쳐 요청이 들어와도 하나씩 순서대로 처리하기 위한 플래그
const queue = [];

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
      ],
    });
  }
  return browser;
}

async function autoScrollAndWaitImages(page, maxHeight = MAX_HEIGHT) {
  await page.evaluate(async (maxH) => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        const h = Math.min(document.body.scrollHeight, maxH);
        window.scrollBy(0, 400);
        total += 400;
        if (total >= h) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
    });
  }, maxHeight);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('img'));
    await Promise.all(
      imgs.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 3000);
        });
      })
    );
  });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function doCapture({ url, selector, scale }) {
  const br = await getBrowser();
  const context = await br.newContext({
    viewport: { width: 800, height: 800 },
    deviceScaleFactor: Math.min(Number(scale) || 2, MAX_SCALE),
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
      }`,
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await autoScrollAndWaitImages(page, MAX_HEIGHT);

    let buffer;
    if (selector) {
      const el = await page.$(selector);
      buffer = el
        ? await el.screenshot({ type: 'png' })
        : await page.screenshot({ fullPage: true, type: 'png' });
    } else {
      const pageHeight = await page.evaluate(() => document.body.scrollHeight);
      if (pageHeight > MAX_HEIGHT) {
        await page.evaluate((maxH) => {
          document.body.style.maxHeight = maxH + 'px';
          document.body.style.overflow = 'hidden';
        }, MAX_HEIGHT);
      }
      buffer = await page.screenshot({ fullPage: true, type: 'png' });
    }
    return buffer;
  } finally {
    await context.close(); // 메모리 회수 핵심
  }
}

// 동시 요청이 와도 하나씩 순서대로 처리 (무료 서버 메모리 보호)
function runQueued(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isBusy || queue.length === 0) return;
  isBusy = true;
  const { job, resolve, reject } = queue.shift();
  try {
    const result = await job();
    resolve(result);
  } catch (e) {
    reject(e);
  } finally {
    isBusy = false;
    processQueue();
  }
}

app.post('/api/capture', async (req, res) => {
  const { url, selector, scale } = req.body || {};

  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: '올바른 URL을 입력해주세요 (http:// 또는 https://로 시작).' });
  }

  const position = queue.length;
  if (position > 0) {
    console.log(`대기열 ${position}번째로 등록됨: ${url}`);
  }

  try {
    const buffer = await runQueued(() => doCapture({ url, selector, scale }));
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '캡쳐에 실패했어요. 페이지 로딩이 너무 오래 걸리거나 접근이 막힌 사이트일 수 있어요.' });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행중: http://localhost:${PORT}`);
});
