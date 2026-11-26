import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 16000 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'gate320-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ws, seq = 0; const pending = new Map();
for (let i = 0; i < 120; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; } } catch (e) {} await sleep(200); }
ws.onmessage = (evt) => { const m = JSON.parse(evt.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p })); }); };
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result && r.result.value; };

let bad = 0;
const push = (name, ok, extra = '') => { if (!ok) bad++; console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: `${BASE}/admin?t=${Date.now()}` });
await sleep(1300);
await ev("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit();");
await sleep(2200);
push('登录进入后台', await ev("!!document.getElementById('app') && getComputedStyle(document.getElementById('gate')).display === 'none'"));

const tabs = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.nav[data-tab]')].map(function (b) { return b.dataset.tab; }))`));
push('14 个面板都在', tabs.length === 14, 'count=' + tabs.length);

const over = []; const small = []; const tight = [];
for (const tab of tabs) {
  await ev(`document.querySelector('.nav[data-tab="${tab}"]').click();`);
  await sleep(420);
  const r = JSON.parse(await ev(`(function () {
    var pane = document.getElementById('pane-' + ${JSON.stringify(tab)});
    var pr = pane.getBoundingClientRect();
    var o = { over: 0, small: [], tight: [] };
    if (pane.scrollWidth > pane.clientWidth + 1) o.over = pane.scrollWidth - pane.clientWidth;
    pane.querySelectorAll('*').forEach(function (el) {
      if (el.closest('[hidden]') || el.hidden) return;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      var txt = (el.children.length === 0 ? (el.textContent || '') : '').trim();
      var tag = el.tagName.toLowerCase();
      if (txt && parseFloat(cs.fontSize) < 12 && !/^(code|pre|kbd|samp|textarea)$/.test(tag)) o.small.push(txt.slice(0, 12));
      var clickable = /^(button|a)$/.test(tag) || el.getAttribute('role') === 'button';
      if (clickable && rect.height < 28) {
        var lab = el.closest('label');
        var lh = lab ? lab.getBoundingClientRect().height : 0;
        if (lh < 40) o.tight.push(tag + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height));
      }
    });
    o.small = o.small.slice(0, 3); o.tight = o.tight.slice(0, 3);
    return JSON.stringify(o);
  })()`));
  if (r.over) over.push(tab + '+' + r.over);
  if (r.small.length) small.push(tab + ':' + r.small.join('|'));
  if (r.tight.length) tight.push(tab + ':' + r.tight.join('|'));
}
push('14 个面板都不横向溢出', over.length === 0, over.join(' '));
push('14 个面板无 <12px 文字', small.length === 0, small.join(' '));
push('可点目标都够大（<28px 且无大 label）', tight.length === 0, tight.join(' '));

await ev("document.querySelector('.nav[data-tab=\"articles\"]').click();");
await sleep(500);
push('文章卡日期 ≥12.5px', await ev("Array.from(document.querySelectorAll('#artTbody td')).some(function (td) { return parseFloat(getComputedStyle(td).fontSize) >= 12.5; })"));
push('文章卡操作按钮 ≥44px 高', await ev("Array.from(document.querySelectorAll('#artTbody button')).every(function (b) { return b.getBoundingClientRect().height >= 43.5; })"));

await ev("document.querySelector('.nav[data-tab=\"nav\"]').click();");
await sleep(500);
push('导航面板工具栏换行（不被撑破）', await ev("getComputedStyle(document.querySelector('#pane-nav .nav-toolbar')).flexWrap === 'wrap'"));
push('导航表格外层可横滚', await ev("(function () { var t = document.querySelector('#pane-nav table'); var c = t && t.closest('.card'); return !!c && ['auto','scroll'].indexOf(getComputedStyle(c).overflowX) >= 0; })()"));

await ev("document.querySelector('.nav[data-tab=\"submit\"]').click();");
await sleep(500);
push('提交页平台表改成卡片（无 min-width）', await ev("(function () { var t = document.querySelector('#pane-submit table.geo-plat'); return !!t && parseFloat(getComputedStyle(t).minWidth) === 0; })()"));
push('提交页长链接与代码强制断行', await ev("(function () { var c = document.querySelector('#pane-submit code'); return !!c && getComputedStyle(c).wordBreak === 'break-all'; })()"));

try { ws.close(); } catch (e) {}
chrome.kill();
console.log(bad === 0 ? 'ALL OK' : bad + ' FAILED');
process.exit(bad === 0 ? 0 : 1);
