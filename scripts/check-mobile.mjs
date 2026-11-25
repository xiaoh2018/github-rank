// 移动端横向溢出体检：390px 宽逐页量 scrollWidth，并列出最宽的元素
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const PAGES = (process.argv[2] || '/,/articles,/faq,/nav').split(',').map((s) => s.trim()).filter(Boolean);
const W = Number(process.argv[3] || 390);
const H = Number(process.argv[4] || 844);

const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-probe-'));
const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  const myId = ++id;
  ws.send(JSON.stringify({ id: myId, method, params }));
  return new Promise((res) => pending.set(myId, res));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });

const expr = `(() => {
  const de = document.documentElement;
  const vw = window.innerWidth;
  const sw = de.scrollWidth;
  const cw = de.clientWidth;
  const wide = [];
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > vw + 1 && r.height > 0) {
      wide.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40), w: Math.round(r.width) });
    }
  });
  wide.sort((a, b) => b.w - a.w);
  return { vw, sw, cw, overflow: sw > cw + 1, wide: wide.slice(0, 6) };
})()`;

for (const p of PAGES) {
  await send('Page.navigate', { url: BASE + p + (p.includes('?') ? '&' : '?') + 'probe=' + Date.now() });
  await sleep(2200);
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = r.result && r.result.result && r.result.result.value;
  const flag = v && v.overflow ? 'OVERFLOW' : 'ok';
  console.log(p, flag, JSON.stringify(v));
}

try { await send('Browser.close'); } catch {}
child.kill();
