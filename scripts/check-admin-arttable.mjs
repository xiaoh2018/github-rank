import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const PORT = 9940 + Math.floor(Math.random() * 50);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'at-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();
let fails = 0, total = 0;

async function connect() { for (let i = 0; i < 80; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; return; } } catch (e) {} await sleep(200); } throw new Error('CDP 连不上'); }
function send(method, params = {}) { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); }); }
async function e(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; }
async function waitFor(expr, ms = 20000) { for (let t = 0; t < ms; t += 200) { try { if (await e(expr)) return true; } catch (err) {} await sleep(200); } return false; }
function ok(name, cond, extra = '') { total++; if (cond) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + '  ' + extra); } }

async function login() {
  await send('Page.navigate', { url: BASE + '/admin' });
  await waitFor("!!document.getElementById('pw')");
  await sleep(300);
  await e("(function(){document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); return 'ok';})()");
  const okLogin = await waitFor("document.getElementById('app') && document.getElementById('app').hidden === false", 12000);
  if (!okLogin) {
    const msg = await e("(document.getElementById('gateMsg')||{}).textContent||'（无提示）'");
    throw new Error('登录没成功：' + msg);
  }
  await sleep(500);
  await e("document.querySelector('.nav[data-tab=\"articles\"]').click()");
  await waitFor("document.getElementById('pane-articles') && getComputedStyle(document.getElementById('pane-articles')).display !== 'none'");
  await waitFor("document.querySelectorAll('#artTbody tr td').length>4");
  await waitFor("(function(){var t=document.querySelector('#artTbody tr');return t && t.getBoundingClientRect().height>40;})()");
  await sleep(700);
}

const M = `(function(){
  var rows = Array.from(document.querySelectorAll('#artTbody tr'));
  if (!rows.length) return { rowCount: 0 };
  var tr = rows[0];
  var tds = Array.from(tr.children);
  var acts = Array.from((tds[4] || document.createElement('td')).querySelectorAll('button'));
  var card = document.querySelector('#artTbody').closest('.card');
  var thead = document.querySelector('#pane-articles table thead');
  return {
    rowCount: rows.length,
    trDisplay: getComputedStyle(tr).display,
    theadDisplay: thead ? getComputedStyle(thead).display : 'missing',
    rowH: Math.round(tr.getBoundingClientRect().height),
    titleSize: tds[2] ? getComputedStyle(tds[2]).fontSize : 'missing',
    clamp: tds[3] ? getComputedStyle(tds[3]).webkitLineClamp : 'missing',
    summaryW: tds[3] ? Math.round(tds[3].getBoundingClientRect().width) : 0,
    cardW: Math.round(card.getBoundingClientRect().width),
    cardScroll: card.scrollWidth,
    docSW: document.documentElement.scrollWidth,
    docCW: document.documentElement.clientWidth,
    acts: acts.map(function(b){ var r=b.getBoundingClientRect(); return { t: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; })
  };
})()`;

(async () => {
  await connect(); await send('Page.enable'); await send('Runtime.enable');

  // —— 390 手机
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await login();
  const m = await e(M);
  ok('[390] 每行变成卡片（display:grid）', m.trDisplay === 'grid', m.trDisplay);
  ok('[390] 表头隐藏', m.theadDisplay === 'none', m.theadDisplay);
  ok('[390] 行高不再被摘要撑到 600+', m.rowH > 90 && m.rowH <= 230, 'rowH=' + m.rowH);
  ok('[390] 摘要占满整行且最多两行', m.clamp === '2' && m.summaryW >= m.cardW - 80, JSON.stringify({ clamp: m.clamp, summaryW: m.summaryW, cardW: m.cardW }));
  ok('[390] 标题字号加大到 15px', m.titleSize === '15px', m.titleSize);
  ok('[390] 卡片不再横向滚动', m.cardScroll <= m.cardW + 1, JSON.stringify({ cardScroll: m.cardScroll, cardW: m.cardW }));
  ok('[390] 整页不溢出', m.docSW <= m.docCW + 1, JSON.stringify({ sw: m.docSW, cw: m.docCW }));
  ok('[390] 操作按钮齐全（编辑/预览/删除）', ['编辑', '预览', '删除'].every((t) => m.acts.some((a) => a.t === t)), JSON.stringify(m.acts.map((a) => a.t)));
  ok('[390] 操作按钮高度 ≥40（好点）', m.acts.every((a) => a.h >= 40), JSON.stringify(m.acts.map((a) => a.h)));
  ok('[390] 操作按钮同一行', new Set(m.acts.map((a) => a.top)).size === 1, JSON.stringify(m.acts.map((a) => a.top)));

  // —— 1440 桌面：保持表格
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await login();
  const d = await e(M);
  ok('[1440] 仍是表格行（display:table-row）', d.trDisplay === 'table-row', d.trDisplay);
  ok('[1440] 表头可见', d.theadDisplay === 'table-header-group' || d.theadDisplay === 'table-row-group' || d.theadDisplay !== 'none', d.theadDisplay);
  ok('[1440] 行高正常（≤120）', d.rowH <= 120, 'rowH=' + d.rowH);
  ok('[1440] 操作按钮齐全（编辑/预览/删除）', ['编辑', '预览', '删除'].every((t) => d.acts.some((a) => a.t === t)), JSON.stringify(d.acts.map((a) => a.t)));
  ok('[1440] 桌面按钮不高（≤40）', d.acts.every((a) => a.h <= 40), JSON.stringify(d.acts.map((a) => a.h)));

  console.log('\n' + (fails ? 'FAILED ' + fails + ' / ' + total : 'ALL OK (' + total + ')'));
  try { ws.close(); } catch (err) {}
  chrome.kill();
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error('ERROR ' + err.message); try { chrome.kill(); } catch (e2) {} process.exit(1); });
