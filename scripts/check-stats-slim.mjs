import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, height, mobile) {
  const port = 9600 + Math.floor(Math.random() * 200);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(os.tmpdir(), 'cr-st-' + width + '-' + Date.now()), 'about:blank'], { stdio: 'ignore' });
  let url = null;
  for (let i = 0; i < 60 && !url; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/list'); const l = await r.json(); const p = l.find((x) => x.type === 'page'); if (p) url = p.webSocketDebuggerUrl; } catch {}
    if (!url) await sleep(300);
  }
  const ws = new WebSocket(url);
  let id = 0; const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((res) => { const my = ++id; waiting.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: !!mobile });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  const shot = async (file, h) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h || height, scale: 1 } });
    fs.writeFileSync(path.join('docs/shots', file), Buffer.from(r.result.data, 'base64'));
  };
  return { evalJs, shot, close: () => { ws.close(); child.kill(); } };
}

const rows = [];
const push = (ok, name, extra = '') => rows.push({ ok: !!ok, name, extra });

const probe = `(() => {
  const s = document.getElementById('stats');
  const r = s.getBoundingClientRect();
  const kids = [...s.children];
  return JSON.stringify({
    cls: s.className,
    h: Math.round(r.height),
    text: s.textContent.replace(/\\s+/g, ' ').trim(),
    cards: kids.filter(k => k.classList.contains('stat')).length,
    kidBoxes: kids.map(k => Math.round(k.getBoundingClientRect().y)),
    lang: (document.getElementById('lang') || {}).value || '',
    count: (document.getElementById('pageInfo') || {}).textContent || '',
    listTop: Math.round(document.getElementById('list').getBoundingClientRect().top),
    docSw: document.documentElement.scrollWidth,
    docCw: document.documentElement.clientWidth
  });
})()`;

// 390 手机
let s = await session(390, 844, true);
await s.evalJs('1');
await s.evalJs('location.href = "http://127.0.0.1:8123/"');
await sleep(3200);
const m = JSON.parse(await s.evalJs(probe));
push(m.cls.indexOf('slim') >= 0, '统计区换成细一行（stats slim）', m.cls);
push(m.h <= 34, '统计区高度 ≤34（原来 182）', 'h=' + m.h);
push(m.cards === 0, '不再渲染四张大卡', 'cards=' + m.cards);
push(/个项目/.test(m.text), '摘要含「N 个项目」', m.text.slice(0, 40));
push(/\d+(\.\d+)?[k]?\s*星/.test(m.text), '摘要含星标总数', m.text.slice(0, 40));
push(/最热/.test(m.text), '摘要含「最热 语言」', m.text.slice(0, 60));
push(m.listTop <= 850, '榜单更早出现（原 961）', 'listTop=' + m.listTop);
await s.shot('home-stats-390.png', 900);

const clicked = JSON.parse(await s.evalJs(`(() => {
  const before = (document.getElementById('pageInfo')||{}).textContent || '';
  const b = document.querySelector('#stats .stat-lang');
  if (!b) return JSON.stringify({ noBtn: true });
  const want = b.title.replace(/^只看 /, '').replace(/（.*$/, '');
  b.click();
  return JSON.stringify({ want, before, lang: (document.getElementById('lang')||{}).value || '' });
})()`));
await sleep(600);
const after = JSON.parse(await s.evalJs(probe));
push(!clicked.noBtn && clicked.lang === clicked.want, '点「最热语言」即按该语言筛选', (clicked.lang || '') + ' vs ' + (clicked.want || ''));
push(after.count !== clicked.before, '筛选后条目数变化（真的过滤了）', clicked.before + ' -> ' + after.count);
push(after.docSw === after.docCw, '手机端不横向溢出', 'sw/cw=' + after.docSw + '/' + after.docCw);
s.close();

// 1440 桌面
s = await session(1440, 900, false);
await s.evalJs('location.href = "http://127.0.0.1:8123/"');
await sleep(3200);
const w = JSON.parse(await s.evalJs(probe));
push(w.h <= 34, '桌面统计区也压成一行（原来 85）', 'h=' + w.h);
push(Math.max.apply(null, w.kidBoxes) - Math.min.apply(null, w.kidBoxes) <= 2, '桌面所有元素同一行（±2px 基线差）', w.kidBoxes.join(','));
push(w.listTop <= 520, '桌面榜单更早出现（原 544）', 'listTop=' + w.listTop);
await s.shot('home-stats-1440.png', 760);
s.close();

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
