// 通用截图：node scripts/shot-url.mjs <url> <out.png> [width] [waitMs]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
const out = path.resolve(process.argv[3] || 'docs/shots/shot.png');
const width = Number(process.argv[4] || 1440);
const waitMs = Number(process.argv[5] || 3500);
const port = 9600 + Math.floor(Math.random() * 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=' + width + ',1000', 'about:blank',
], { stdio: 'ignore' });

let page = null;
for (let i = 0; i < 40 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch (e) {}
  if (!page) await sleep(250);
}
if (!page) { console.error('CDP 未就绪'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const wait = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
await send('Page.navigate', { url });
await sleep(waitMs);
const m = await send('Page.getLayoutMetrics');
const h = Math.min(Math.ceil(m.cssContentSize.height) + 30, 4200);
await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: width < 600 });
await sleep(500);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (!shot || !shot.data) { console.error('截图失败'); process.exit(1); }
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out, fs.statSync(out).size + 'B', width + 'x' + h);
try { ws.close(); child.kill(); } catch (e) {}
