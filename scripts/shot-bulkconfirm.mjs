// 截图：后台「批量改分类」二次确认弹窗
// 用法：先起 dev-server（8123），再 node scripts/shot-bulkconfirm.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const out = process.argv[2] || 'docs/shots/admin-bulk-confirm.png';
const port = 10020 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shotbulk-'));
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
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/admin?v=' + Date.now() });
await sleep(2400);
await evalJs(`(() => { var p = document.getElementById('pw'); if (p) p.value = 'dev'; var f = document.getElementById('loginForm'); if (f) f.requestSubmit(); return 1; })()`);
await sleep(2000);
await evalJs(`(() => { var n = document.querySelector('.nav[data-tab="articles"]'); if (n) n.click(); return 1; })()`);
await sleep(1500);
await evalJs(`(() => {
  var cb = document.querySelector('#artTbody [data-artpick]');
  if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  var sel = document.getElementById('artBulkCat');
  var val = [...sel.options].map(o => o.value).filter(Boolean)[0];
  sel.value = val; sel.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('artBulkApply').click();
  return val;
})()`);
await sleep(800);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved ' + out + ' ' + fs.statSync(out).size + 'B');
try { ws.close(); } catch {}
try { child.kill(); } catch {}
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
