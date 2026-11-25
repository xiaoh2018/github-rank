#!/usr/bin/env node
/**
 * 一键出图：把前台/后台各页面截图写到 docs/shots/。
 *
 * 用法：
 *   1) 先起本地预览服务（另开一个终端）：node scripts/dev-server.mjs
 *   2) 再跑：node scripts/shots.mjs            # 全部
 *            node scripts/shots.mjs nav admin  # 只跑部分
 *
 * 依赖：本机装了 Chrome / Edge。脚本用 Chrome 的 --screenshot 直接出图，
 * 每个页面都换一个临时 user-data-dir，避免磁盘缓存把旧样式带出来。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const OUT = path.join(HERE, '..', 'docs', 'shots');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

/** 页面清单：name -> { url, width, height, file } */
const PAGES = {
  home: { url: '/?range=week', width: 1440, height: 1600, file: 'home.png' },
  'home-double': { url: '/?range=week&view=repos', width: 1440, height: 1600, file: 'home-double.png' },
  'home-mobile': { url: '/?range=week', width: 500, height: 1500, file: 'home-mobile.png' },
  total: { url: '/?range=total', width: 1440, height: 1600, file: 'total-list.png' },
  nav: { url: '/?page=nav', width: 1440, height: 1400, file: 'nav-page.png' }
  // 后台各页要登录，用 scripts/preview-admin.mjs 生成（它会把密码自动填好）
};

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge，可设环境变量 CHROME_PATH 指定路径');
}

function shoot(chrome, name, cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghrank-shot-'));
  const out = path.join(OUT, cfg.file);
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--force-device-scale-factor=1',
      `--user-data-dir=${dir}`,
      `--window-size=${cfg.width},${cfg.height}`,
      '--virtual-time-budget=8000',
      `--screenshot=${out}`,
      BASE + cfg.url
    ],
    { stdio: 'ignore', timeout: 90000 }
  );
  fs.rmSync(dir, { recursive: true, force: true });
  const size = fs.statSync(out).size;
  console.log(`  ${name.padEnd(13)} -> docs/shots/${cfg.file}  ${(size / 1024).toFixed(0)}KB`);
}

function main() {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(PAGES);
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = findChrome();
  console.log(`Chrome: ${chrome}`);
  console.log(`Base  : ${BASE}`);
  console.log('截图（需要先跑 node scripts/dev-server.mjs）：');
  for (const name of names) {
    const cfg = PAGES[name];
    if (!cfg) {
      console.log(`  ? 未知页面 ${name}（可选：${Object.keys(PAGES).join(' / ')}）`);
      continue;
    }
    try {
      shoot(chrome, name, cfg);
    } catch (e) {
      console.log(`  ${name.padEnd(13)} 失败：${e.message}`);
    }
  }
  console.log(`完成，输出目录：${OUT}`);
}

main();