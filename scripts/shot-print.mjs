// 打印视图截图：用 CDP 把媒体类型切成 print，再整页截图存 docs/shots/print-*.png
// 用法：node scripts/shot-print.mjs [宽度]
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8123';
const width = Number(process.argv[2] || 900);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = 'docs/shots';

const PAGES = [
  { url: '/articles', name: 'print-articles-list' },
  { url: '/articles/tech/4.html', name: 'print-article' },
  { url: '/', name: 'print-home' },
];

const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'print-'));
const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio', '--user-data-dir=' + profile, '--remote-debugging-port=' + String(port), 'about:blank'], { stdio: 'ignore' });

let ws = null;
let id = 0;
const waits = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const mid = ++id;
  waits.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
});

let target = null;
let lastErr = '';
for (let i = 0; i < 80; i++) {
  await sleep(200);
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/list');
    const list = await r.json();
    target = list.find((t) => t.type === 'page');
  } catch (e) {
    lastErr = e && e.message ? e.message : String(e);
  }
  if (target) break;
}
if (!target) {
  console.error('Chrome 调试端口没起来：' + lastErr);
  proc.kill();
  process.exit(1);
}

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waits.has(m.id)) {
    const w = waits.get(m.id);
    waits.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  }
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { media: 'print' });

fs.mkdirSync(OUT, { recursive: true });
try {
  for (const p of PAGES) {
    await send('Page.navigate', { url: BASE + p.url });
    await sleep(2400);
    const met = await send('Page.getLayoutMetrics');
    const h = Math.min(6000, Math.ceil((met.cssContentSize && met.cssContentSize.height) || 1200));
    await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, p.name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('saved ' + file + ' (' + width + 'x' + h + ')');
  }
} finally {
  try { ws.close(); } catch (e) {}
  proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
