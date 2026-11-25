// 用法：node scripts/shot.mjs <url> <输出png> [宽] [高] [滚动到的选择器]
// 用 CDP 的 Emulation.setDeviceMetricsOverride 设视口（headless 的 --window-size 最小只有 500px，
// 测 390/320 宽必须走这里，否则截出来是被裁切的 500px 布局）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, out, wArg, hArg, sel] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法：node scripts/shot.mjs <url> <输出png> [宽] [高] [选择器]');
  process.exit(1);
}
const w = Number(wArg || 1440);
const h = Number(hArg || 1000);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9400 + Math.floor(Math.random() * 200);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shot-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    target = list.find((x) => x.type === 'page');
  } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 640 });
await send('Page.navigate', { url });
await sleep(2400);
if (sel) {
  await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ block: 'start' }); return el ? 1 : 0; })()` });
  await sleep(800);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out, fs.statSync(out).size + 'B', w + 'x' + h);
try { await send('Browser.close'); } catch {}
child.kill();
