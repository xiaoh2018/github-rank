// 后台窄屏表单门禁：14 个面板逐一检查 ①文本类控件高度≥34 且字号≥16（iOS 聚焦不放大） ②宽表都有可横向滚动的祖先 ③整页不横向溢出
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 390);

const port = 9500 + Math.floor(Math.random() * 120);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-aform-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  try { const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = list.find((t) => t.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const myId = ++id; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((res) => pending.set(myId, res)); };
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: BASE + '/admin' });
await sleep(2600);
await ev(`(() => { const p = document.getElementById('pw'); if (p) p.value = 'dev'; document.getElementById('loginForm').requestSubmit(); return 1; })()`);
await sleep(2600);

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fails.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); console.log('  FAIL  ' + name + ' :: ' + JSON.stringify(detail)); }
}

const tabs = await ev(`Array.from(document.querySelectorAll('.nav')).map((b) => b.getAttribute('data-tab'))`);
check('后台面板数量 >= 14', tabs.length >= 14, tabs.length);

const probe = `(() => {
  const pane = document.querySelector('.pane:not([hidden])');
  if (!pane) return { err: 'no pane' };
  const bad = [];
  pane.querySelectorAll('input, select, textarea').forEach((el) => {
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio' || t === 'hidden') return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.height < 1) return;                 // 折叠区域里的控件不算
    if (r.height < 34) bad.push({ id: el.id || el.tagName.toLowerCase(), why: 'h=' + Math.round(r.height) });
    else if (parseFloat(cs.fontSize) < 16) bad.push({ id: el.id || el.tagName.toLowerCase(), why: 'fs=' + parseFloat(cs.fontSize) });
  });
  const wide = [];
  pane.querySelectorAll('table').forEach((tb) => {
    if (tb.getBoundingClientRect().width <= pane.clientWidth + 1) return;
    let a = tb.parentElement, ok = false;
    while (a && a !== document.body) {
      const cs = getComputedStyle(a);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1) { ok = true; break; }
      a = a.parentElement;
    }
    if (!ok) wide.push(String(tb.className || '(none)'));
  });
  return { bad: bad.slice(0, 4), wide: wide.slice(0, 3) };
})()`;

for (const t of tabs) {
  await ev(`(() => { const b = document.querySelector('.nav[data-tab="${t}"]'); if (b) b.click(); return 1; })()`);
  await sleep(700);
  const r = await ev(probe);
  check('面板 ' + t + '：控件高度与字号达标', r && r.bad && r.bad.length === 0, r && r.bad);
  check('面板 ' + t + '：宽表在可滚动容器里', r && r.wide && r.wide.length === 0, r && r.wide);
}

const doc = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
check('后台整页在 ' + W + 'px 下不横向溢出', doc && doc.sw <= doc.cw + 1, doc);

try { await send('Browser.close'); } catch {}
child.kill();

console.log('');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  fails.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('全部通过（' + pass + ' 项，视口 ' + W + 'px，' + tabs.length + ' 个面板）');
