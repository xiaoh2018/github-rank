// 前台表单可访问名：每个控件都要有真名字（aria-label / label[for] / 祖先 label），placeholder 不算
// 用法：node scripts/check-front-labels.mjs   （PROBE_BASE 可指向线上）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/+$/, '');
let pass = 0;
let fail = 0;
const rows = [];
const push = (name, ok, info) => {
  rows.push((ok ? 'OK   ' : 'FAIL ') + name + (info === undefined ? '' : '  → ' + info));
  ok ? pass++ : fail++;
};

const port = 9600 + Math.floor(Math.random() * 300);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const proc = spawn(chrome, [
  '--headless=new',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + userDir,
  '--window-size=1440,900',
  '--no-first-run',
  'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
let id = 0;
const pending = new Map();
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
      });
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      };
      break;
    }
  } catch {}
  await sleep(200);
}
if (!ws) {
  console.error('连不上 CDP：可能有残留 headless chrome 占着端口，先清掉再跑');
  process.exit(2);
}
const send = (method, params) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result && r.result.result ? r.result.result.value : null;
};

await send('Page.enable');
await send('Runtime.enable');

const SCAN = `(function(){
  const out = [];
  document.querySelectorAll('input,select,textarea').forEach(function(el){
    if (el.type === 'hidden') return;
    const al = (el.getAttribute('aria-label') || '').trim();
    const alb = (el.getAttribute('aria-labelledby') || '').trim();
    let lbl = '';
    if (el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) lbl = (l.textContent || '').trim(); }
    if (!lbl) { const p = el.closest('label'); if (p) lbl = (p.textContent || '').trim(); }
    const name = al || lbl || alb;
    out.push({ id: el.id || '', kind: el.tagName.toLowerCase() + '[' + (el.type || '') + ']', name: name, ph: (el.getAttribute('placeholder') || '').trim() });
  });
  return out;
})()`;

for (const page of ['/', '/articles', '/faq']) {
  await send('Page.navigate', { url: BASE + page });
  await sleep(2300);
  const list = await ev(SCAN);
  if (!Array.isArray(list)) {
    push(page + ' 控件清单可读', false, JSON.stringify(list).slice(0, 80));
    continue;
  }
  const unnamed = list.filter((x) => !x.name);
  const phOnly = unnamed.filter((x) => x.ph);
  push(page + ' 控件都有可访问名（placeholder 不算）', unnamed.length === 0, unnamed.length ? unnamed.map((x) => x.kind + '#' + (x.id || '?')).join(', ') : list.length + ' 个控件');
  push(page + ' 没有只靠 placeholder 的控件', phOnly.length === 0, phOnly.map((x) => (x.id || x.kind)).join(',') || '0');
  const names = list.map((x) => x.name).filter(Boolean);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  push(page + ' 同一页控件名不重复', dup.length === 0, dup.join(' | ') || names.length + ' 个唯一名');
}

await send('Page.navigate', { url: BASE + '/?unit=1' });
await sleep(2300);
const pwToken = await ev("(function(){var t=document.getElementById('token'); if(!t) return 'missing'; return {type: t.type, label: t.getAttribute('aria-label')};})()");
push('设置里的 Token 有可访问名且仍是密码框', !!(pwToken && pwToken.type === 'password' && /Token/.test(pwToken.label || '')), JSON.stringify(pwToken));

const artPw = await ev("(function(){var t=document.getElementById('artDlgPw'); if(!t) return 'missing'; return {type: t.type, label: t.getAttribute('aria-label')};})()");
push('文章弹窗密码框有可访问名', !!(artPw && artPw.type === 'password' && /密码/.test(artPw.label || '')), JSON.stringify(artPw));

await send('Page.navigate', { url: BASE + '/articles?unit=1' });
await sleep(2300);
const pwIn = await ev("(function(){var t=document.getElementById('pwIn'); if(!t) return 'missing'; return {type: t.type, label: t.getAttribute('aria-label'), ac: t.getAttribute('autocomplete')};})()");
push('静态文章页密码框有可访问名', !!(pwIn && pwIn.type === 'password' && /密码/.test(pwIn.label || '')), JSON.stringify(pwIn));

console.log(rows.join('\n'));
console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL OK (' + pass + ')') + '  @' + BASE);
try {
  ws.close();
} catch {}
try {
  proc.kill();
} catch {}
try {
  fs.rmSync(userDir, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);
