// 切换类控件的 aria-pressed（v232）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9500 + Math.floor(Math.random() * 300);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, '--window-size=' + W + ',' + H, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
for (let i = 0; i < 40; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); const p = l.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; break; } } catch {}
  await sleep(200);
}
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };
await send('Page.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 760 });
await send('Page.navigate', { url: BASE + '/' });
await sleep(2400);

const marks = () => js(`(function(){
  function pressed(sel){return Array.prototype.map.call(document.querySelectorAll(sel),function(b){return b.getAttribute('aria-pressed');});}
  var f=document.querySelector('#list .item .fav');
  return {views: pressed('#views .btn'), ranges: pressed('#ranges .btn'), cats: pressed('.cat').slice(0,4),
    favOnly: document.getElementById('btnFavFilter') ? document.getElementById('btnFavFilter').getAttribute('aria-pressed') : 'no-el',
    fav: f ? f.getAttribute('aria-pressed') : 'no-el', favTxt: f ? f.textContent.trim() : ''};})()`);

const m1 = await marks();
check('三档榜单都有 aria-pressed', m1.views.length === 3 && m1.views.every((v) => v === 'true' || v === 'false'), m1.views);
check('默认选中「项目榜」（第一个 true，其余 false）', m1.views[0] === 'true' && m1.views[1] === 'false' && m1.views[2] === 'false', m1.views);
check('四个时间档都有 aria-pressed 且第一个为 true', m1.ranges.length === 4 && m1.ranges[0] === 'true' && m1.ranges.slice(1).every((v) => v === 'false'), m1.ranges);
check('分类胶囊有 aria-pressed（本轮前就有）', m1.cats.length === 4 && m1.cats.every((v) => v === 'true' || v === 'false'), m1.cats);
check('「只看收藏」是开关且有 pressed=false', m1.favOnly === 'false', m1.favOnly);
check('卡片收藏星初始 pressed=false', m1.fav === 'false', m1.fav);

await js(`(function(){var b=document.querySelectorAll('#views .btn')[1];b.click();})()`);
await sleep(900);
const m2 = await marks();
check('点「开发者榜」后 pressed 换位', m2.views[1] === 'true' && m2.views[0] === 'false', m2.views);

await js(`(function(){var b=document.querySelectorAll('#ranges .btn')[1];b.click();})()`);
await sleep(900);
const m3 = await marks();
check('点「近 30 天」后 pressed 换位', m3.ranges[1] === 'true' && m3.ranges[0] === 'false', m3.ranges);

await js(`(function(){document.querySelectorAll('#views .btn')[0].click();})()`);
await sleep(1000);
await js(`(function(){var b=document.querySelector('#list .item .fav');b.click();return 1;})()`);
await sleep(250);
const m4 = await js(`(function(){var f=document.querySelector('#list .item .fav');return {p:f.getAttribute('aria-pressed'),t:f.textContent.trim()};})()`);
check('点收藏后 pressed=true 且变实心星', m4.p === 'true' && m4.t === '★', m4);
await js(`(function(){document.querySelector('#list .item .fav').click();})()`);
await sleep(250);
const m5 = await js(`(function(){var f=document.querySelector('#list .item .fav');return {p:f.getAttribute('aria-pressed'),t:f.textContent.trim()};})()`);
check('再点一次回 pressed=false 且空心星', m5.p === 'false' && m5.t === '☆', m5);

await js(`(function(){document.getElementById('btnFavFilter').click();})()`);
await sleep(700);
const m6 = await js(`(function(){var b=document.getElementById('btnFavFilter');return {p:b.getAttribute('aria-pressed'),t:b.textContent.trim()};})()`);
check('「只看收藏」打开后 pressed=true 且文案带（开）', m6.p === 'true' && /（开）/.test(m6.t), m6);

check('页面不横向溢出', (await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1')) === true, await js('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'));

const failed = results.filter((r) => !r.ok);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
console.log('\n' + (failed.length ? failed.length + ' 项未通过 / ' + results.length : 'ALL OK (' + results.length + ')') + '  @' + W + 'px  ' + BASE);
process.exit(failed.length ? 1 : 0);