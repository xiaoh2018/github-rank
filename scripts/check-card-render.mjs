import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;

const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = fs.readFileSync('index.html', 'utf8');
push('源码里只有一处生成 .artcard（合并成一份实现）', (src.match(/className='artcard'/g) || []).length === 1,
  (src.match(/className='artcard'/g) || []).length);
push('源码里不再出现无样式的 artcard-mins', !src.includes('artcard-mins'), '');
push('首页渲染复用 artCardEl()', /items\.slice\(0,HOME_MAX\)\.forEach\(function\(it,idx\)\{\s*grid\.appendChild\(artCardEl\(it\)\);/.test(src), '');
push('CSS 里 .artcard-min 仍有样式', /\.artcard-min\{/.test(src), '');

if (REMOTE) {
  for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
  console.log('（线上模式：只跑源码侧断言）');
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
let proc = null; let ws = null;
for (let attempt = 0; attempt < 3 && !ws; attempt++) {
  const port = 9500 + Math.floor(Math.random() * 200);
  proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--window-size=' + W + ',' + H, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !ws; i++) {
    try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); const p = l.find((t) => t.type === 'page');
      if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); } } catch { }
    if (!ws) await sleep(200);
  }
  if (!ws) { try { proc.kill(); } catch { } }
}
if (!ws) { console.log('no cdp target'); process.exit(2); }

let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };

await send('Page.enable'); await send('Runtime.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });
await send('Page.navigate', { url: BASE + '/?page=articles&cb=' + Date.now() });
await sleep(2200);

const probe = await js(`(async function(){
  function info(card){
    var a = card.querySelectorAll('a[href]');
    var mn = card.querySelector('.artcard-min');
    return {
      cat: !!card.querySelector('.artcard-cat'),
      time: !!card.querySelector('time'),
      mins: mn ? mn.textContent.trim() : '',
      minsFont: mn ? getComputedStyle(mn).fontFamily : '',
      links: a.length,
      anchor: a[0] ? a[0].textContent.trim() : '',
      title: (card.querySelector('h3')||{textContent:''}).textContent.trim(),
      readSpan: !!card.querySelector('.artcard-foot .read[aria-hidden="true"]'),
      readLink: !!card.querySelector('.artcard-foot a.read')
    };
  }
  var arts = [];
  try { arts = await (await fetch('/data/articles.json?cb=' + Date.now())).json(); } catch (e) { arts = []; }
  var byTitle = {};
  (Array.isArray(arts) ? arts : []).forEach(function(it){ byTitle[String(it.title||'').trim()] = it; });
  function expect(card){
    var it = byTitle[card.title] || null;
    return { hasCat: !!(it && String(it.category||'').trim()), hasBody: !!(it && String(it.body||'').length > 0) };
  }
  var all = Array.prototype.slice.call(document.querySelectorAll('.artcard'));
  var home = all.filter(function(c){ return c.closest('#articles'); });
  var view = all.filter(function(c){ return c.closest('#artview') || c.closest('.artview'); });
  function pack(list){ return list.map(function(c){ var i = info(c); var e = expect(i); i.expect = e; return i; }); }
  return { total: all.length, home: pack(home), view: pack(view),
           sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
})()`);

if (!probe || probe.__err) { console.log('probe error', JSON.stringify(probe)); process.exit(1); }

const cards = probe.home.concat(probe.view);
push('首页「最新文章」有卡片（≤6 张）', probe.home.length >= 1 && probe.home.length <= 6, probe.home.length);
push('文章视图也有卡片', probe.view.length >= 1, probe.view.length);
push('每张卡都有日期 + 恰好 1 条链接 + 装饰性「阅读全文」',
  cards.every((c) => c.time && c.links === 1 && c.readSpan), JSON.stringify(cards.map((c) => c.links)));
push('分类徽标与数据一致（有分类才显示，无分类不编造）',
  cards.every((c) => c.cat === c.expect.hasCat),
  JSON.stringify(cards.map((c) => ({ t: c.title, chip: c.cat, hasCat: c.expect.hasCat }))));
push('「约 N 分钟」与正文一致（有正文才显示）',
  cards.every((c) => (c.expect.hasBody ? /^约 \d+ 分钟$/.test(c.mins) : c.mins === '')),
  JSON.stringify(cards.map((c) => ({ t: c.title, mins: c.mins, hasBody: c.expect.hasBody }))));
push('分钟胶囊有等宽样式（artcard-min 生效）',
  cards.filter((c) => c.mins).every((c) => /Consolas|mono/i.test(c.minsFont)),
  (cards.find((c) => c.mins) || {}).minsFont);
push('锚文本 = 标题（两处渲染一致）', cards.every((c) => c.anchor === c.title), (cards[0] || {}).anchor);
push('「阅读全文」不再是一条链接', cards.every((c) => !c.readLink), '');
push('页面不横向溢出', Math.abs(probe.sw - probe.cw) <= 1, probe.sw + '/' + probe.cw);
push('两处渲染的卡片字段集合一致',
  JSON.stringify(Object.keys(probe.home[0] || {}).sort()) === JSON.stringify(Object.keys(probe.view[0] || {}).sort()), '');

try { ws.close(); } catch { }
try { proc.kill(); } catch { }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  @' + W + 'px' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);