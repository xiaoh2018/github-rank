import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = fs.readFileSync('index.html', 'utf8');
push('首页不再急加载 md.js', !/<script[^>]+src="\/?js\/md\.js"/.test(src), '');
push('源码里有 ensureMd() 按需加载', src.includes('function ensureMd()') && src.includes("el.src = '/js/md.js'"), '');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
let proc = null; let ws = null;
for (let attempt = 0; attempt < 3 && !ws; attempt++) {
  const port = 9600 + Math.floor(Math.random() * 200);
  proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--window-size=' + W + ',' + H, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !ws; i++) {
    try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); const p = l.find((t) => t.type === 'page');
      if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); } } catch { }
    if (!ws) await sleep(200);
  }
  if (!ws) { try { proc.kill(); } catch { } }
}
if (!ws) { console.log('no cdp target'); process.exit(2); }

let id = 0; const pending = new Map(); const reqs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent' && m.params && m.params.request) reqs.push(m.params.request.url);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });

reqs.length = 0;
await send('Page.navigate', { url: BASE + '/?page=articles&cb=' + Date.now() });
await sleep(2000);
const mdBefore = reqs.filter((u) => /\/js\/md\.js/.test(u)).length;
push('首屏（文章视图）不请求 md.js', mdBefore === 0, 'md.js 请求 ' + mdBefore + ' 次');
push('首屏 window.KeeMd 未定义（确实没加载）', (await js('typeof window.KeeMd')) === 'undefined', await js('typeof window.KeeMd'));

const opened = await js(`(async function(){
  var arts = [];
  try { arts = await (await fetch('/data/articles.json?cb=' + Date.now())).json(); } catch (e) { arts = []; }
  if (!Array.isArray(arts)) arts = [];
  var withBody = arts.filter(function(it){ return String(it.body||'').length > 0; });
  var target = withBody[0];
  if (!target) return 'no-article-with-body';
  var cards = Array.prototype.slice.call(document.querySelectorAll('.artcard'));
  var hit = cards.filter(function(c){
    var t = (c.querySelector('h3')||{textContent:''}).textContent.trim();
    return t === String(target.title||'').trim();
  })[0];
  var a = hit ? hit.querySelector('a[data-artpost]') : null;
  if (!a) return 'no-card-for-target';
  a.click();
  return 'clicked:' + target.title;
})()`);
await sleep(1400);
push('点开的是有正文的那篇（按数据挑，不猜）', String(opened).indexOf('clicked:') === 0, opened);
push('点开文章后触发 md.js 加载', reqs.filter((u) => /\/js\/md\.js/.test(u)).length >= 1, 'md.js 请求 ' + reqs.filter((u) => /\/js\/md\.js/.test(u)).length + ' 次');
push('md.js 到位后 KeeMd 可用', (await js('typeof window.KeeMd')) === 'object' || (await js('typeof window.KeeMd')) === 'function', await js('typeof window.KeeMd'));
const body = await js(`(function(){ var b=document.querySelector('#artDlg .adl-body'); return b ? { html: b.innerHTML.slice(0,120), hasH: /<h[2-4]/.test(b.innerHTML), busy: b.getAttribute('aria-busy') } : null; })()`);
push('弹窗正文已渲染成 HTML（不是纯文本）', !!(body && body.hasH && !body.busy), JSON.stringify(body));

reqs.length = 0;
await send('Page.navigate', { url: BASE + '/articles/tech/4.html?cb=' + Date.now() });
await sleep(1800);
push('静态文章页仍直接加载 md.js（首屏就要正文）', reqs.filter((u) => /\/js\/md\.js/.test(u)).length >= 1, 'md.js 请求 ' + reqs.filter((u) => /\/js\/md\.js/.test(u)).length + ' 次');
const abody = await js(`(function(){ var ab=document.querySelector('#reader .abody'); return ab ? { hasH: /<h[2-4]/.test(ab.innerHTML), len: ab.innerHTML.length } : null; })()`);
push('静态页正文渲染正常', !!(abody && abody.hasH && abody.len > 50), JSON.stringify(abody));

const ov = await js(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
push('静态页不横向溢出', ov && Math.abs(ov.sw - ov.cw) <= 1, JSON.stringify(ov));

try { ws.close(); } catch { }
try { proc.kill(); } catch { }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  @' + W + 'px' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);