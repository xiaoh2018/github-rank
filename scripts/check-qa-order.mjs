// 问答排序门禁：后台「问答」面板每行要有 ↑ ↓，点了能真正换顺序（不保存，重进还原）。
// 用法：先起 dev-server（8123），再 node scripts/check-qa-order.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9650 + Math.floor(Math.random() * 250);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-qa-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

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
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 220) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const login = async () => {
  await sleep(1600);
  await evalJs(`(() => { const p = document.querySelector('#pw'); if (p) { p.value = ${JSON.stringify(PW)}; const f = document.querySelector('#loginForm'); if (f) f.requestSubmit(); } return 1; })()`);
  await sleep(1500);
  await evalJs(`(() => { const n = document.querySelector('.nav[data-tab="qa"]'); if (n) n.click(); return 1; })()`);
  await sleep(1000);
};

const before = await (await fetch(base + '/api/qa?v=' + Date.now())).json().catch(() => ({}));
const beforeItems = (before.qa || {}).items || [];
console.log('保存前的问答条数：' + beforeItems.length);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/admin' });
await login();

console.log('== 1. 面板与按钮 ==');
const rows = await evalJs(`document.querySelectorAll('#qaList .qa-row').length`);
ok('问答面板打开了', rows > 0, 'rows=' + rows);
const btn = await evalJs(`(() => { const r = document.querySelectorAll('#qaList .qa-row'); return { up: document.querySelectorAll('#qaList [data-qaup]').length, down: document.querySelectorAll('#qaList [data-qadn]').length, rows: r.length }; })()`);
ok('每行都有上移按钮', btn.up === btn.rows, JSON.stringify(btn));
ok('每行都有下移按钮', btn.down === btn.rows, JSON.stringify(btn));
const edge = await evalJs(`(() => {
  const rowsEl = [...document.querySelectorAll('#qaList .qa-row')];
  if (rowsEl.length < 2) return 'skip';
  const f = rowsEl[0].querySelector('[data-qaup]');
  const l = rowsEl[rowsEl.length - 1].querySelector('[data-qadn]');
  return (f && f.disabled && l && l.disabled) ? 'ok' : 'bad';
})()`);
ok('第一条上移 / 最后一条下移是禁用的', edge === 'ok' || edge === 'skip', String(edge));

console.log('== 2. 把第 1 条下移一位 ==');
const startOrder = await evalJs(`[...document.querySelectorAll('#qaList .qa-q')].map(i => i.value).slice(0, 3)`);
const swapped = await evalJs(`(() => {
  const rowsEl = [...document.querySelectorAll('#qaList .qa-row')];
  const dn = rowsEl[0].querySelector('[data-qadn]');
  if (!dn) return 'no-button';
  dn.click();
  return [...document.querySelectorAll('#qaList .qa-q')].map(i => i.value).slice(0, 3);
})()`);
ok('下移后前两条换了位置', Array.isArray(swapped) && swapped[0] === startOrder[1] && swapped[1] === startOrder[0], JSON.stringify({ startOrder, swapped }));

console.log('== 3. 再把它上移回来 ==');
const back = await evalJs(`(() => {
  const rowsEl = [...document.querySelectorAll('#qaList .qa-row')];
  const up = rowsEl[1].querySelector('[data-qaup]');
  if (!up) return 'no-button';
  up.click();
  return [...document.querySelectorAll('#qaList .qa-q')].map(i => i.value).slice(0, 3);
})()`);
ok('上移后回到原顺序', Array.isArray(back) && back[0] === startOrder[0] && back[1] === startOrder[1], JSON.stringify({ startOrder, back }));

console.log('== 4. 新问题按钮只加一行 ==');
const added = await evalJs(`(() => {
  const b = document.querySelector('#qaNew');
  const n0 = document.querySelectorAll('#qaList .qa-row').length;
  b.click();
  const n1 = document.querySelectorAll('#qaList .qa-row').length;
  return { n0, n1 };
})()`);
ok('点一次「新问题」多一行', added.n1 === added.n0 + 1, JSON.stringify(added));

console.log('== 5. 不保存，重进面板要还原 ==');
await send('Page.navigate', { url: base + '/admin' });
await login();
const sameOrder = await evalJs(`[...document.querySelectorAll('#qaList .qa-q')].map(i => i.value).slice(0, 3)`);
ok('重进后顺序回到线上数据', JSON.stringify(sameOrder) === JSON.stringify(startOrder), JSON.stringify({ startOrder, sameOrder }));
const after = await (await fetch(base + '/api/qa?v=' + Date.now())).json().catch(() => ({}));
const afterItems = (after.qa || {}).items || [];
ok('线上问答条数没变', afterItems.length === beforeItems.length, beforeItems.length + ' -> ' + afterItems.length);

console.log(fails ? `问答排序门禁 ${fails} 项失败` : '问答排序门禁全部通过');
try { await send('Browser.close'); } catch {}
child.kill();
process.exit(fails ? 1 : 0);
