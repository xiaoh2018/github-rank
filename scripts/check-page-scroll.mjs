// 翻页后的落点体检：翻到第 2 页应当停在「列表顶」，而不是被拉回页面顶
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 390);
const H = Number(process.argv[3] || 844);
const MOBILE = W < 761;

const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scroll-'));
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('no cdp target');
}
const t = await findTarget();
const ws = new WebSocket(t.webSocketDebuggerUrl);
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.text));
  return r.result && r.result.result && r.result.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: MOBILE });

let pass = 0;
let fail = 0;
function push(name, ok, extra = '') {
  if (ok) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
}

await send('Page.navigate', { url: BASE + '/?probe=' + Date.now() });
await sleep(2400);

const loaded = await ev(`document.querySelectorAll('#list .item').length`);
push('首页列表已加载（≥10 条）', loaded >= 10, 'items=' + loaded);

const geo = await ev(`(() => {
  window.scrollTo(0, document.documentElement.scrollHeight);
  const l = document.getElementById('list');
  const r = l.getBoundingClientRect();
  return { listTop: Math.round(r.top + window.scrollY), margin: getComputedStyle(l).scrollMarginTop, y: Math.round(window.scrollY) };
})()`);
push('列表声明了 scroll-margin-top（给吸顶工具条留位置）', geo.margin === '76px', 'margin=' + geo.margin);

const before = await ev(`(document.getElementById('pageInfo') || {}).textContent || ''`);
await ev(`document.getElementById('next').click()`);
await sleep(900);

const after = await ev(`(() => {
  const l = document.getElementById('list');
  const r = l.getBoundingClientRect();
  return { y: Math.round(window.scrollY), top: Math.round(r.top),
           info: (document.getElementById('pageInfo') || {}).textContent || '',
           items: document.querySelectorAll('#list .item').length };
})()`);

push('翻页确实换了内容', after.items >= 10 && after.info !== before, JSON.stringify({ before, after: after.info }));
push('没有回到页面顶（scrollY > 0）', after.y > 0, 'y=' + after.y);
push('落点在列表顶附近（±60px）', Math.abs(after.y - (geo.listTop - 76)) <= 60, 'y=' + after.y + ' expect~' + (geo.listTop - 76));
push('列表顶紧贴视口上沿（0–110px）', after.top >= -5 && after.top <= 110, 'top=' + after.top);

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
await sleep(200);
await ev(`document.getElementById('prev').click()`);
await sleep(120);
const y1 = await ev(`Math.round(window.scrollY)`);
push('减少动效时瞬时就位（120ms 内到位）', Math.abs(y1 - (geo.listTop - 76)) <= 60, 'y=' + y1);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
await sleep(150);
await ev(`document.getElementById('top').click()`);
await sleep(1800);
const yTop = await ev(`Math.round(window.scrollY)`);
push('「回到顶部」按钮仍然回到页面顶', yTop <= 4, 'y=' + yTop);

const ovf = await ev(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`);
push('没有横向溢出', ovf === false, String(ovf));

console.log(`\n${fail === 0 ? 'ALL OK' : fail + ' FAILED'} (${pass + fail} 项，${W}px)`);
try { await send('Browser.close'); } catch {}
child.kill();
process.exit(fail === 0 ? 0 : 1);