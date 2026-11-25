// 用 CDP 截后台面板（headless Chrome 直接打开 /admin 再登录下面的 tab）
// 用法：node scripts/cdp-shot.mjs <pane> <输出路径> [宽度]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pane = process.argv[2] || 'overview';
const out = path.resolve(process.argv[3] || 'docs/shots/admin-' + pane + '.png');
const width = Number(process.argv[4] || 1440);
const port = 9500 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--disable-dev-shm-usage',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile,
  '--window-size=' + width + ',900',
  'about:blank',
], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result);
    waiting.delete(msg.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params) =>
  new Promise((resolve) => {
    const mid = ++id;
    waiting.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:8123/admin' });
await sleep(1600);
await send('Runtime.evaluate', {
  expression: `(() => { const p = document.getElementById('pw'); if (p) { p.value = 'dev'; } const f = document.getElementById('loginForm'); if (f) { f.requestSubmit(); } return 'login'; })()`,
});
await sleep(2000);
await send('Runtime.evaluate', {
  expression: `(() => { const b = document.querySelector('.nav[data-tab="${pane}"]'); if (b) { b.click(); return 'clicked ' + b.textContent.trim(); } return 'no tab'; })()`,
});
await sleep(2200);
const metrics = await send('Page.getLayoutMetrics');
const h = Math.min(4200, Math.ceil((metrics.cssContentSize && metrics.cssContentSize.height) || 1400));
await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });
await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved ' + out + ' (' + width + 'x' + h + ', ' + fs.statSync(out).size + ' bytes)');
await send('Browser.close');
ws.close();
child.kill();
