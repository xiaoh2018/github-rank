// 截图：文章阅读器 + 顶部阅读进度条（滚到正文中段）
// 用法：先起 dev-server（8123），再 node scripts/shot-reader-progress.mjs [输出png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const out = process.argv[2] || 'docs/shots/article-progress.png';
const port = 10240 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shotprog-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 860, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/articles?v=' + Date.now() });
await sleep(2600);
await evalJs(`(() => { var c = document.querySelector('#cards .acard'); if (c) c.click(); return !!c; })()`);
await sleep(1400);
await evalJs(`(() => { var ab = document.querySelector('#reader .abody'); if (!ab) return 0; var top = ab.getBoundingClientRect().top + window.scrollY; window.scrollTo(0, top + ab.offsetHeight * 0.45); window.dispatchEvent(new Event('scroll')); return Math.round(window.scrollY); })()`);
await sleep(900);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved ' + out + ' ' + fs.statSync(out).size + 'B');
try { ws.close(); } catch {}
try { child.kill(); } catch {}
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
