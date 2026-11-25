// 前台页面自动审计：多页面 × 多宽度，检查控制台报错 / 请求失败 / 横向溢出 / 无障碍小问题
// 用法：node scripts/audit-front.mjs [baseUrl]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:8123').replace(/\/$/, '');
const PAGES = ['/', '/articles', '/faq', '/nav'];
const WIDTHS = [1440, 768, 390];
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
let errors = [];
const reqUrl = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg.result); waiting.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params && msg.params.exceptionDetails;
    errors.push('exception: ' + ((d && (d.exception && d.exception.description || d.text)) || '').slice(0, 200));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
    errors.push('console: ' + (msg.params.args || []).map((a) => a.value || a.description || a.type).join(' ').slice(0, 200));
  }
  if (msg.method === 'Network.requestWillBeSent' && msg.params) {
    reqUrl.set(msg.params.requestId, msg.params.request && msg.params.request.url);
  }
  if (msg.method === 'Network.loadingFailed' && msg.params && !msg.params.canceled) {
    const u = reqUrl.get(msg.params.requestId) || '';
    if (u.indexOf(base) === 0) errors.push('request: ' + String(msg.params.errorText || '') + ' ' + u.replace(base, ''));
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params) => new Promise((resolve) => {
  const mid = ++id;
  waiting.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
});
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const probe = `(function () {
  var de = document.documentElement;
  var cw = de.clientWidth;
  var over = [];
  Array.prototype.slice.call(document.querySelectorAll('body *')).forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > cw + 1.5) {
      var tag = el.tagName.toLowerCase();
      var cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      var s = tag + cls;
      if (over.indexOf(s) < 0) over.push(s);
    }
  });
  var noLabel = [];
  Array.prototype.slice.call(document.querySelectorAll('button, a.btn, a[role=button]')).forEach(function (el) {
    var t = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (!t) noLabel.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(/\\s+/)[0]);
  });
  var noAlt = 0;
  Array.prototype.slice.call(document.querySelectorAll('img')).forEach(function (im) {
    if (!im.getAttribute('alt') && im.getAttribute('alt') !== '') noAlt++;
  });
  return JSON.stringify({
    cw: cw, sw: de.scrollWidth, over: over.slice(0, 6), noLabel: noLabel.slice(0, 6), noAlt: noAlt,
    hidden: document.body.getAttribute('data-page') || ''
  });
})()`;

let bad = 0;
for (const p of PAGES) {
  for (const w of WIDTHS) {
    errors = [];
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
    await send('Page.navigate', { url: base + p + '?audit=' + Date.now() });
    await sleep(2200);
    const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
    let info = {};
    try { info = JSON.parse(r.result.value); } catch (e) { info = { parse: 'fail' }; }
    const over = info.sw > info.cw + 1 ? info.over : [];
    const uniqErrors = Array.from(new Set(errors.map((e) => e.replace(/\d{2,}/g, 'N'))));
    const ok = !over.length && !uniqErrors.length && !info.noLabel.length;
    if (!ok) bad++;
    console.log((ok ? 'OK   ' : 'FAIL ') + p + ' @' + w + '  sw=' + info.sw + '/cw=' + info.cw +
      (over.length ? '  over=' + over.join(' ') : '') +
      (uniqErrors.length ? '  err=' + uniqErrors.slice(0, 3).join(' | ') : '') +
      (info.noLabel.length ? '  无文字按钮=' + info.noLabel.join(' ') : '') +
      (info.noAlt ? '  img无alt=' + info.noAlt : ''));
  }
}

console.log(bad === 0 ? 'ALL OK (' + PAGES.length * WIDTHS.length + ' 组合)' : bad + ' 组合有问题');
try { ws.close(); } catch (e) {}
try { child.kill(); } catch (e) {}
process.exit(bad === 0 ? 0 : 1);
