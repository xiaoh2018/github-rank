// 封面图卫生：<img> 而不是 CSS background-image（能占位、能惰性加载、读屏有 alt）
// 本地跑：会临时给两篇文章写入 cover，跑完原样还原 data/articles.json
// 线上跑（PROBE_BASE=https://github.661026.xyz）：不写数据，改为断言页面里的标记载法
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !/127\.0\.0\.1|localhost/.test(BASE);
const COVER = '/og-image.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (name, ok, extra) => { rows.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); };

let dataBackup = null;
if (!REMOTE) {
  const f = 'data/articles.json';
  dataBackup = fs.readFileSync(f);
  const arr = JSON.parse(dataBackup.toString('utf8'));
  if (Array.isArray(arr) && arr.length >= 1) { arr[0].cover = COVER; if (arr[2]) arr[2].cover = COVER; }
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
}

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-cover-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 120 && !target; i++) { try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(150); }
if (!target) { console.error('no cdp page'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.text)); return r.result.result.value; };
await send('Page.enable'); await send('Runtime.enable');

const INFO = `function(el){
  if(!el) return null;
  var cs=getComputedStyle(el);
  return {tag:el.tagName, cls:el.className, alt:el.getAttribute('alt'), w:el.getAttribute('width'), h:el.getAttribute('height'),
    lazy:el.getAttribute('loading'), dec:el.getAttribute('decoding'), src:(el.getAttribute('src')||'').slice(-24),
    bg:cs.backgroundImage, fit:cs.objectFit, ratio:el.offsetHeight?+(el.offsetWidth/el.offsetHeight).toFixed(2):0};
}`;

if (!REMOTE) {
  // ---------- /articles 卡片 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/articles?t=' + Date.now() });
  await sleep(2800);
  const card = await ev(`(function(){var i=document.querySelector('.acard img.acover');return (${INFO})(i);})()`);
  push('/articles 卡片封面是 <img>', card && card.tag === 'IMG', card && card.tag);
  push('卡片封面 alt 空着（装饰图，不重复念标题）', card && card.alt === '', card && card.alt);
  push('卡片封面带 640×360 固有尺寸', card && card.w === '640' && card.h === '360', card && { w: card.w, h: card.h });
  push('卡片封面惰性加载 + 异步解码', card && card.lazy === 'lazy' && card.dec === 'async', card && { lazy: card.lazy, dec: card.dec });
  push('卡片封面用 object-fit 裁切，不再画 background', card && card.fit === 'cover' && card.bg === 'none', card && { fit: card.fit, bg: card.bg });
  push('卡片封面保持 16:9（不塌陷不拉伸）', card && Math.abs(card.ratio - 16 / 9) < 0.12, card && card.ratio);
  const leftovers = await ev(`({span:document.querySelectorAll('.acard span.acover').length, div:document.querySelectorAll('#list div.artcard-cover').length})`);
  push('没有残留的 span/div 假封面', leftovers.span === 0, leftovers);

  // ---------- 首页文章卡 ----------
  await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
  await sleep(2800);
  const homeC = await ev(`(function(){var i=document.querySelector('.artcard img.artcard-cover');return (${INFO})(i);})()`);
  push('首页文章卡封面也是 <img>', homeC && homeC.tag === 'IMG', homeC && homeC.tag);
  push('首页封面 alt 为空 + 尺寸齐 + 惰性', homeC && homeC.alt === '' && homeC.w === '640' && homeC.lazy === 'lazy', homeC && { alt: homeC.alt, w: homeC.w, lazy: homeC.lazy });
  push('首页封面 object-fit 裁切', homeC && homeC.fit === 'cover', homeC && homeC.fit);

  // ---------- 阅读器头图 ----------
  await send('Page.navigate', { url: BASE + '/articles/cat/1.html' });
  await sleep(2800);
  const rc = await ev(`(function(){var i=document.querySelector('#rBody img.rcover');return (${INFO})(i);})()`);
  push('阅读器头图是 <img> 且带 1200×675', rc && rc.tag === 'IMG' && rc.w === '1200' && rc.h === '675', rc && { tag: rc.tag, w: rc.w, h: rc.h });
  push('阅读器头图不被惰性加载（首屏）', rc && rc.lazy !== 'lazy' && rc.dec === 'async', rc && { lazy: rc.lazy, dec: rc.dec });
  push('阅读器头图 object-fit 裁切', rc && rc.fit === 'cover', rc && rc.fit);

  // ---------- 390 不溢出 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/articles?t=' + Date.now() });
  await sleep(2600);
  const ov = await ev(`(function(){var d=document.documentElement;var i=document.querySelector('.acard img.acover');var c=i?i.closest('.acard'):null;return {sw:d.scrollWidth,cw:d.clientWidth,iw:i?i.offsetWidth:0,cw2:c?c.clientWidth:0};})()`);
  push('390 宽封面不撑破卡片', ov && ov.sw <= ov.cw + 1 && ov.iw <= ov.cw2 + 1, ov);
} else {
  // ---------- 线上：只读页面标记 ----------
  const artHtml = await (await fetch(BASE + '/articles?t=' + Date.now())).text();
  const homeHtml = await (await fetch(BASE + '/?t=' + Date.now())).text();
  push('线上 /articles 用 <img class="acover">', artHtml.includes('<img class="acover"') && artHtml.includes('loading="lazy"'));
  push('线上 /articles 不再用 background 画封面', !artHtml.includes('background:var(--chip) center/cover'));
  push('线上 /articles 阅读器头图是 <img class="rcover"', artHtml.includes('<img class="rcover"'));
  push('线上首页有封面工厂函数 coverImg', homeHtml.includes('coverImg(it.cover)') && homeHtml.includes("createElement('img')"));
}

ws.close();
try { child.kill(); } catch {}
if (dataBackup) { fs.writeFileSync('data/articles.json', dataBackup); console.log('data/articles.json 已还原'); }
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + '/' + rows.length : 'ALL OK (' + rows.length + ')') + '  ' + BASE);
process.exit(bad.length ? 1 : 0);
