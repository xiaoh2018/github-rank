import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/$/, '');
const W = Number(process.env.W || 1440);

const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const port = 9300 + Math.floor(Math.random() * 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + dir,
  '--window-size=' + W + ',900', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

let ws = null;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); }
  } catch { }
  if (!ws) await sleep(200);
}
if (!ws) { console.log('no cdp target'); proc.kill(); process.exit(2); }

let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.text || '') + ' ' + ((r.result.exceptionDetails.exception || {}).description || '') };
  return r.result && r.result.result ? r.result.result.value : null;
};
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1400); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 500 });

// —— A. /articles 静态列表 ——
await go(base + '/articles');

const stat = await js(`(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('.acard'));
  return {
    n: cards.length,
    links: cards.map(function(c){ return c.querySelectorAll('a').length; }),
    pair: cards.map(function(c){
      var a = c.querySelector('a');
      var h = c.querySelector('h3');
      return {
        anchor: a ? a.textContent.trim() : '',
        title: h ? h.textContent.replace('置顶','').trim() : '',
        href: a ? a.getAttribute('href') : ''
      };
    }),
    generic: Array.prototype.filter.call(document.querySelectorAll('a'), function(a){ return /阅读全文/.test(a.textContent); }).length
  };
})()`);

push('/articles 至少 2 张卡片', stat && stat.n >= 2, stat && stat.n);
push('/articles 每张卡只有 1 条链接', stat && stat.links.every((n) => n === 1), stat && JSON.stringify(stat.links));
push('/articles 锚文本 = 卡片标题', stat && stat.pair.every((p) => p.anchor && p.anchor === p.title),
  stat && JSON.stringify(stat.pair.map((p) => [p.anchor, p.title])));
push('/articles 锚文本不是「阅读全文」', stat && stat.generic === 0, stat && stat.generic);
push('/articles 链接指向规范文章地址', stat && stat.pair.every((p) => /^\/articles\/[a-z]+\/\d+\.html$/.test(p.href)),
  stat && JSON.stringify(stat.pair.map((p) => p.href)));

const opened = await js(`(function(){
  var c = document.querySelector('.acard');
  if (!c) return 'no-card';
  c.click();
  return document.getElementById('reader') && !document.getElementById('reader').hidden ? 'open' : 'closed';
})()`);
push('/articles 点卡片（非锚点）也能打开阅读器', opened === 'open', opened);

const statOver = await js(`({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})`);
push('/articles 不横向溢出', statOver && statOver.sw <= statOver.cw + 1, statOver && JSON.stringify(statOver));

// —— B. 首页「最新文章」 ——
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 500 });
await go(base + '/?page=articles');
await sleep(600);

const home = await js(`(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('.artcard'));
  return {
    n: cards.length,
    links: cards.map(function(c){ return c.querySelectorAll('a').length; }),
    pair: cards.map(function(c){
      var a = c.querySelector('a');
      var h = c.querySelector('h3');
      return { anchor: a ? a.textContent.trim() : '', title: h ? h.textContent.trim() : '', post: a ? a.getAttribute('data-artpost') : null };
    }),
    generic: Array.prototype.filter.call(document.querySelectorAll('a'), function(a){ return /阅读全文/.test(a.textContent); }).length,
    readSpan: document.querySelectorAll('.artcard-foot .read').length
  };
})()`);

push('首页文章卡 ≥1 张', home && home.n >= 1, home && home.n);
push('首页每张卡只有 1 条链接', home && home.links.every((n) => n === 1), home && JSON.stringify(home.links));
push('首页锚文本 = 卡片标题', home && home.pair.every((p) => p.anchor && p.anchor === p.title),
  home && JSON.stringify(home.pair.map((p) => [p.anchor, p.title])));
push('首页没有「阅读全文」链接', home && home.generic === 0, home && home.generic);
push('「阅读全文 →」还在，但只是装饰（span + aria-hidden）', home && home.readSpan >= 1, home && home.readSpan);
push('首页文章链接带 data-artpost', home && home.pair.every((p) => p.post !== null && p.post !== ''),
  home && JSON.stringify(home.pair.map((p) => p.post)));

const homeOver = await js(`({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})`);
push('首页不横向溢出', homeOver && homeOver.sw <= homeOver.cw + 1, homeOver && JSON.stringify(homeOver));

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
try { ws.close(); } catch { }
proc.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
process.exit(bad === 0 ? 0 : 1);