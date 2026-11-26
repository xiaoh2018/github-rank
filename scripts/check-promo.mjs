// 门禁：站内广告位不能挂着占位内容（尤其顶部滚动条），否则全站每页都有一条假广告
// 用法：node scripts/check-promo.mjs            （本地 dev-server）
//       PROBE_BASE=https://github.661026.xyz node scripts/check-promo.mjs
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/$/, '');
const PORT = 9200 + Math.floor(Math.random() * 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('OK   ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

// A) 站点配置里不能有「开着但没内容」的滚动条
const raw = await (await fetch(BASE + '/api/site?t=' + Date.now())).json();
const site = (raw && raw.site) || raw || {};
const tk = (site && site.ad && site.ad.ticker) || {};
check('顶部滚动条是关闭的', tk.enabled === false, tk.enabled);
check('滚动条文案为空（没有占位内容）', String(tk.text || '') === '', tk.text);

// B) 源码兜底存在（太短 / 像占位 都会被拒）
const workerSrc = fs.readFileSync('worker.js', 'utf8');
check('服务端会拒绝「文案太短」的滚动条', workerSrc.includes('滚动条的文案太短（') && workerSrc.includes('至少写一句 6 个字以上'));
check('服务端会拒绝「像占位内容」的滚动条', workerSrc.includes('滚动条的文案像占位内容（'));

// C) 四个页面默认都把滚动条藏起来，DOM 里不许留可见的空条
for (let i = 0; i < 80; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; break; } } catch {}
  await sleep(200);
}
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const pages = [['/', '#list .item'], ['/nav', '.nj']];
for (const [p, ready] of pages) {
  await send('Page.navigate', { url: BASE + p + '?t=' + Date.now() });
  const t = Date.now();
  while (Date.now() - t < 20000) { if (await js('!!document.querySelector(' + JSON.stringify(ready) + ')')) break; await sleep(150); }
  await sleep(500);
  const box = await js("(function(){var b=document.getElementById('adTicker');if(!b)return {missing:true};var r=b.getBoundingClientRect();return {hidden:b.hidden, w:Math.round(r.width), h:Math.round(r.height), txt:(b.textContent||'').trim().slice(0,20)};})()");
  check(p + ' 有滚动条容器且默认隐藏', !!box && box.hidden === true, box);
  check(p + ' 的滚动条不可见（0 高）且没有文字', !!box && box.h === 0 && box.txt === '', box);
}

// /articles 与 /faq 是各自独立的页面，压根不该出现这条滚动条
for (const [p, ready] of [['/articles', '#cards .acard'], ['/faq', '#list .q']]) {
  await send('Page.navigate', { url: BASE + p + '?t=' + Date.now() });
  const t = Date.now();
  while (Date.now() - t < 20000) { if (await js('!!document.querySelector(' + JSON.stringify(ready) + ')')) break; await sleep(150); }
  await sleep(500);
  check(p + ' 不出现顶部滚动条', (await js("!document.querySelector('.ad-ticker')")) === true);
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'ALL OK (' + pass + ')') + '  @' + BASE);
ws.close(); proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);