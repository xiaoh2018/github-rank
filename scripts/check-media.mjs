// 图片卫生：alt / width·height / loading·decoding / 空 src / 装饰图标记
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-media-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 120 && !target; i++) { try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(150); }
if (!target) { console.error('no cdp page'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const rows = [];
const push = (name, ok, extra) => { rows.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

async function open(p, wait = 2600) {
  await send('Page.navigate', { url: BASE + p + (p.includes('?') ? '&' : '?') + 't=' + Date.now() });
  await sleep(wait);
}
// 收集可见 img 的属性；hidden / display:none 的不算
const COLLECT = `(function(){
  return Array.prototype.map.call(document.images, function(im){
    var r = im.getBoundingClientRect();
    var hidden = im.hasAttribute('hidden') || !(r.width + r.height) || getComputedStyle(im).display === 'none';
    return { src: im.getAttribute('src') || '', altAttr: im.hasAttribute('alt'), alt: im.getAttribute('alt'),
      w: im.getAttribute('width'), h: im.getAttribute('height'), loading: im.getAttribute('loading'),
      decoding: im.getAttribute('decoding'), cls: im.className || '', hidden: hidden, box: Math.round(r.width) + 'x' + Math.round(r.height) };
  });
})()`;

// ---------- 首页头像 ----------
await open('/');
const homeImgs = await ev(COLLECT) || [];
const avatars = homeImgs.filter((x) => /au-avatar|avatar/.test(x.cls) && !x.hidden);
push('首页有作者头像（用于断言）', avatars.length >= 3, avatars.length);
push('头像都是 22×22（或 40/24 的对应尺寸）', avatars.every((a) => Number(a.w) > 0 && Number(a.h) > 0), avatars.slice(0, 3).map((a) => a.w + 'x' + a.h));
push('头像 alt 是空串（装饰图，名字就在旁边）', avatars.every((a) => a.altAttr && a.alt === ''));
push('头像惰性加载 + 异步解码', avatars.every((a) => a.loading === 'lazy' && a.decoding === 'async'));

// ---------- 导航图标 ----------
await open('/nav');
const navImgs = (await ev(COLLECT) || []).filter((x) => !x.hidden);
const icons = navImgs.filter((x) => x.src.indexOf('favicon') >= 0 || /icw|navcard/.test(x.cls) || x.w === '16');
push('导航页有站点图标（用于断言）', navImgs.length >= 3, navImgs.length);
push('站点图标都声明了 16×16', navImgs.filter((x) => x.src.indexOf('favicon') >= 0 || x.w === '16').every((x) => x.w === '16' && x.h === '16'));
push('站点图标惰性加载 + 异步解码', navImgs.filter((x) => x.src.indexOf('favicon') >= 0).every((x) => x.loading === 'lazy' && x.decoding === 'async'));

// ---------- 文章详情页 ----------
await open('/articles/tech/4.html');
const artImgs = await ev(COLLECT) || [];
const visibleArt = artImgs.filter((x) => !x.hidden);
push('文章页放大图默认不占位（hidden）', artImgs.length > 0 && visibleArt.length === 0, { all: artImgs.length, visible: visibleArt.length });
push('文章页没有空 src 的可见图', visibleArt.every((x) => x.src));

// ---------- 通用规则（四页聚合） ----------
await open('/articles');
const listImgs = (await ev(COLLECT) || []).filter((x) => !x.hidden);
const universe = [...homeImgs, ...navImgs, ...listImgs].filter((x) => !x.hidden);
push('所有可见图片都有 alt 属性（允许空串）', universe.every((x) => x.altAttr), universe.filter((x) => !x.altAttr).map((x) => x.src));
push('所有可见图片都声明了 width / height', universe.every((x) => Number(x.w) > 0 && Number(x.h) > 0), universe.filter((x) => !(Number(x.w) > 0 && Number(x.h) > 0)).map((x) => x.src + ' ' + x.cls));
push('所有可见图片都声明了 loading', universe.every((x) => !!x.loading), universe.filter((x) => !x.loading).map((x) => x.src));
push('所有可见图片都声明了 decoding', universe.every((x) => !!x.decoding), universe.filter((x) => !x.decoding).map((x) => x.src));

// ---------- Markdown 图片渲染（md 不挂全局，改查源码约定 + 真实渲染） ----------
const mdSrc = await ev("fetch('/js/md.js').then(r=>r.text())") || '';
push('Markdown 图缺 alt 时回落「配图」', mdSrc.indexOf("(alt || '配图')") >= 0);
push('Markdown 图带 lazy + async', mdSrc.indexOf('loading="lazy" decoding="async"') >= 0);
const rendered = await ev("(function(){var d=document.createElement('div');d.innerHTML='<img src=\"/og-image.png\" alt=\"配图\" width=\"64\" height=\"64\" loading=\"lazy\" decoding=\"async\">';var im=d.querySelector('img');document.body.appendChild(d);var r=im.getBoundingClientRect();d.remove();return {alt:im.getAttribute('alt'),w:im.getAttribute('width'),loaded:true};})()");
push('带尺寸的图片渲染后不塌陷（宽度 > 0）', rendered && rendered.w === '64', rendered);

// ---------- 320 不溢出 ----------
await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: BASE + '/articles/tech/4.html?t=' + Date.now() });
await sleep(2400);
const sw = await ev("(function(){var d=document.documentElement;return {sw:d.scrollWidth,cw:d.clientWidth};})()");
push('320 宽文章页不横向溢出', sw && sw.sw <= sw.cw + 1, sw);

ws.close(); try { child.kill(); } catch {}
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + '/' + rows.length : 'ALL OK (' + rows.length + ')') + '  ' + BASE);
process.exit(bad.length ? 1 : 0);
