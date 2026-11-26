// 门禁：320px 下文章页分类胶囊单行横滚 + 后台文章工具栏「先筛后排、删除垫底」
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let seeded = [];
const push = (n, ok, extra) => rows.push({ n, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9300 + Math.floor(Math.random() * 60);
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ord-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' });
const wsUrl = await (async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome not ready');
})();
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const waits = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });

  // 造几篇不同分类，让胶囊真的溢出
  const seedTitles = ['__胶囊__A', '__胶囊__B', '__胶囊__C', '__胶囊__D'];
  const seedCats = ['tech', 'note', 'life', 'tool'];
  for (let i = 0; i < seedTitles.length; i++) {
    await fetch(BASE + '/api/articles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'dev', action: 'add', article: { title: seedTitles[i], summary: '门禁', body: '门禁', category: seedCats[i], date: '2026-04-0' + (i + 1) } }),
    });
  }
  const all = await (await fetch(BASE + '/api/articles')).json();
  seeded = (all.articles || []).filter((a) => String(a.title || '').indexOf('__胶囊__') === 0).map((a) => a.id);

  await send('Page.navigate', { url: BASE + '/articles' });
  await sleep(2600);
  const c = await evalJs(`(function(){
    var box = document.getElementById('chips');
    var cs = getComputedStyle(box);
    var chips = Array.prototype.slice.call(box.children);
    var tops = chips.map(function(el){ return Math.round(el.getBoundingClientRect().top); });
    var hs = chips.map(function(el){ return Math.round(el.getBoundingClientRect().height); });
    return {
      wrap: cs.flexWrap, of: cs.overflowX, mask: cs.maskImage || cs.webkitMaskImage || '',
      cls: box.className, n: chips.length,
      oneRow: tops.length ? tops.every(function(t){ return t === tops[0]; }) : true,
      minH: hs.length ? Math.min.apply(null, hs) : 0,
      scrollW: box.scrollWidth, clientW: box.clientWidth
    };
  })()`);
  push('分类胶囊不换行（nowrap）', c && c.wrap === 'nowrap', c && c.wrap);
  push('分类胶囊可横滚（overflow-x auto）', c && c.of === 'auto', c && c.of);
  push('分类胶囊在同一行', c && c.oneRow, c && c.n);
  push('胶囊高度 ≥ 38', c && c.minH >= 38, c && c.minH);
  push('溢出时右缘渐隐生效（mask 含 linear-gradient）', c && c.scrollW - c.clientW > 4 && /linear-gradient/.test(c.mask) && c.cls.indexOf('x-end') < 0, c ? (c.scrollW - c.clientW) + ' ' + String(c.mask).slice(0, 28) : '');

  await evalJs("(function(){var b=document.getElementById('chips'); b.scrollLeft = b.scrollWidth; b.dispatchEvent(new Event('scroll'));})()");
  await sleep(250);
  const cEnd = await evalJs("(function(){var b=document.getElementById('chips');var cs=getComputedStyle(b);return {cls:b.className, mask:cs.maskImage||cs.webkitMaskImage||''};})()");
  push('滚到末尾后渐隐撤掉（x-end 且 mask 不是 linear-gradient）', cEnd && cEnd.cls.indexOf('x-end') >= 0 && !/linear-gradient/.test(cEnd.mask), cEnd && String(cEnd.mask).slice(0, 24));


  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1800);
  await evalJs("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit();");
  await sleep(1500);
  await evalJs("document.querySelector('.nav[data-tab=\"articles\"]').click();");
  await sleep(900);
  const t = await evalJs(`(function(){
    var tb = document.querySelector('#pane-articles .toolbar');
    if (!tb) return { missing: true };
    function box(id){ var el = document.getElementById(id); if (!el) return null; var r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) }; }
    var ids = ['artSort','artCatFilter','artAllMatch','artBulkCat','artBulkApply','artBulkDel','artUndo'];
    var out = {};
    ids.forEach(function(k){ out[k] = box(k); });
    var tops = {}; ids.forEach(function(k){ if (out[k]) tops[out[k].top] = 1; });
    return { out: out, rowCount: Object.keys(tops).length, boxH: Math.round(tb.getBoundingClientRect().height) };
  })()`);
  const o = (t && t.out) || {};
  push('工具栏元素齐全', o.artSort && o.artCatFilter && o.artBulkDel, Object.keys(o).length);
  push('排序在批量删除之前（先筛后排）', o.artSort && o.artBulkDel && o.artSort.top <= o.artBulkDel.top, o.artSort && o.artBulkDel ? o.artSort.top + '<=' + o.artBulkDel.top : '');
  push('分类筛选也在批量删除之前', o.artCatFilter && o.artBulkDel && o.artCatFilter.top <= o.artBulkDel.top, o.artCatFilter && o.artBulkDel ? o.artCatFilter.top + '<=' + o.artBulkDel.top : '');
  push('「删除选中」落在最后一行', o.artBulkDel && o.artUndo && o.artBulkDel.top >= o.artBulkApply.top, o.artBulkDel && o.artBulkApply ? o.artBulkDel.top + '>=' + o.artBulkApply.top : '');
  push('工具栏不超过 4 行', t && t.rowCount <= 4, t && t.rowCount);

if (seeded.length) {
  await fetch(BASE + '/api/articles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'dev', action: 'bulk', ids: seeded, op: 'remove' }) });
}
const left = await (await fetch(BASE + '/api/articles')).text();
push('清理测试文章且无残留', seeded.length > 0 && left.indexOf('__胶囊__') < 0, seeded.length);

} finally {
  ws.close();
  child.kill();
}

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.n + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? '全部通过（' + rows.length + ' 项，320px）' : bad + ' 项失败 / ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
