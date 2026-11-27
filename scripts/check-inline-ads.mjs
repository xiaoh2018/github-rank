import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !BASE.includes('127.0.0.1');
const W = Number(process.env.W || 1440);
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last;
let ws, proc, userDir;
for (let i = 0; i < 3 && !ws; i++) {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const port = await freePort();
  proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, '--window-size=' + W + ',1000', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  for (let k = 0; k < 50; k++) {
    try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); const p = l.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; } } catch (e) { last = e; }
    await sleep(200);
  }
}
if (!ws) throw new Error('cdp 连不上：可能有残留 headless chrome 占着端口（' + (last && last.message) + '）');

let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Fetch.requestPaused') events.push(m.params); };
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1000, deviceScaleFactor: 1, mobile: W < 700 });

let hits = 0;
{
  const base = JSON.parse(await (await fetch(BASE + '/api/site')).text()).site;
  const slots = {};
  ['home-top', 'list-top', 'list-inline', 'list-bottom', 'sidebar', 'article', 'article-inline', 'nav-inline'].forEach((k) => { slots[k] = { enabled: true, html: '<div class="mk">' + k.toUpperCase() + '</div>', every: 5, link: '', modal: '' }; });
  const site = Object.assign({}, base, { ad: Object.assign({}, base.ad, { enabled: true, slots }) });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*data/site.json*' }, { urlPattern: '*api/site*' }] });
  const pump = setInterval(async () => {
    while (events.length) {
      const ev = events.shift(); hits++;
      const body = Buffer.from(JSON.stringify(site)).toString('base64');
      await send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body });
    }
  }, 15);
  globalThis.__pump = pump;
}

await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
await sleep(3400);
const out = await js(`(function(){
  var list=document.getElementById('list');
  var kids=list?[].slice.call(list.children):[];
  var items=kids.filter(function(n){return n.classList.contains('item')&&!n.classList.contains('ad-inline')}).length;
  var ads=kids.filter(function(n){return n.classList.contains('ad-inline')}).length;
  var lastAd=!!(list&&list.lastElementChild&&list.lastElementChild.classList.contains('ad-inline'));
  var grid=document.querySelector('.artgrid');
  var gridLastAd=!!(grid&&grid.lastElementChild&&grid.lastElementChild.classList.contains('ad-inline'));
  var navLast=[].slice.call(document.querySelectorAll('.navgird')).map(function(g){var l=g.lastElementChild;return !!(l&&l.classList.contains('ad-inline-card'))});
  return {items:items, ads:ads, lastAd:lastAd, gridLastAd:gridLastAd, navGroups:navLast.length, navLastAd:navLast.filter(Boolean).length, sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth};
})()`);
let nav = { groups: 0, lastAd: 0 };
{
  await send('Page.navigate', { url: BASE + '/?page=nav&t=' + Date.now() });
  await sleep(4600);
  nav = await js(`(function(){var gs=[].slice.call(document.querySelectorAll('.navgird'));return {groups:gs.length,lastAd:gs.filter(function(g){var l=g.lastElementChild;return !!(l&&l.classList.contains('ad-inline-card'))}).length};})()`);
}
if (globalThis.__pump) clearInterval(globalThis.__pump);

{
  push('拦截确实命中（否则下面全是空转）', hits > 0, 'hits=' + hits);
  push('列表里插了信息流广告', out.ads >= 1, 'ads=' + out.ads);
  push('广告数量按每 5 条插一条算（不含末尾）', out.ads === Math.floor((out.items - 1) / 5), out.ads + ' for ' + out.items + ' items');
  push('列表最后一个不是广告（末尾不追一条）', out.lastAd === false, 'lastAd=' + out.lastAd);
  push('文章卡网格最后一个不是广告', out.gridLastAd === false, 'gridLastAd=' + out.gridLastAd);
  push('导航页有分组（先证明看得见）', nav.groups >= 3, nav.groups + ' 组');
  push('导航分组最后一个不是广告', nav.groups > 0 && nav.lastAd === 0, nav.lastAd + ' / ' + nav.groups + ' 组');
  push('页面不横向溢出', out.sw <= out.cw + 1, out.sw + '/' + out.cw);
}

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  → ' + r.extra : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  @' + W + 'px  ' + BASE : bad + ' FAILED of ' + rows.length);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(bad === 0 ? 0 : 1);
