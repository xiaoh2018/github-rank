// 前台四页在窄屏下的表单可用性：字号 ≥16px（iOS 不自动放大）、高度 ≥40、整页不溢出
// 用法：先 node scripts/dev-server.mjs，再 node scripts/check-front-mobile-forms.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.GHRANK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGES = [
  ['首页', '/'],
  ['文章页', '/articles'],
  ['问答页', '/faq'],
  ['导航页', '/nav'],
];
const VIEWPORTS = [
  ['390', 390, 844],
  ['320', 320, 720],
];

const results = [];
const push = (ok, name, extra = '') => results.push({ ok, name, extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9700 + Math.floor(Math.random() * 100);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-fmf-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
  if (!target) await sleep(250);
}
if (!target) {
  console.log('FAIL Chrome 没起来（先杀 20 分钟内的僵尸 chrome 再跑）');
  child.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => {
  const myId = ++id;
  ws.send(JSON.stringify({ id: myId, method, params }));
  return new Promise((res) => pending.set(myId, res));
};
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result && r.result.result.value;
};

await send('Page.enable');
await send('Runtime.enable');

const probe = `(() => {
  const out = [];
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'hidden' || el.disabled) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    out.push({ id: el.id || el.tagName.toLowerCase(), h: Math.round(r.height), fs: parseFloat(getComputedStyle(el).fontSize) });
  });
  return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, controls: out };
})()`;

for (const [vpName, w, h] of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  for (const [pageName, url] of PAGES) {
    await send('Page.navigate', { url: BASE + url });
    await sleep(2800);
    const r = await ev(probe);
    const tag = `${pageName}@${vpName}`;
    const bad = r.controls.filter((c) => c.fs < 16 || c.h < 40);
    push(bad.length === 0, `${tag} 表单字号≥16 且 高度≥40`, bad.length ? JSON.stringify(bad) : `${r.controls.length} 个控件`);
    push(r.sw <= r.cw + 1, `${tag} 整页不横向溢出`, `sw=${r.sw} cw=${r.cw}`);
  }
}

try { await send('Browser.close'); } catch {}
child.kill();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '  OK  ' : ' FAIL '} ${r.name}${r.extra ? ' :: ' + r.extra : ''}`);
if (failed.length) {
  console.log(`\n失败 ${failed.length} 项 / 通过 ${results.length - failed.length} 项`);
  process.exit(1);
}
console.log(`\n全部通过（${results.length} 项，${VIEWPORTS.length} 个视口 × ${PAGES.length} 个页面）`);
