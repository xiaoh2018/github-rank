// 无障碍/可用性审计：每个页面上数一遍
//   1) 表单控件没有可访问名称（无 aria-label / label[for] / title / placeholder 且无文本）
//   2) <img> 没有 alt
//   3) <button> 没有文字也没有 aria-label/title
//   4) 标题层级跳跃（h2 → h4 这种）
//   5) 可点击元素没有焦点样式（tabindex="-1" 的除外，无法静态判断，跳过）
// 用法：node scripts/audit-a11y.mjs            （默认 5 页 × 1440）
//       node scripts/audit-a11y.mjs 390        （指定宽度）
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8123';
const width = Number(process.argv[2] || 1440);
const PAGES = ['/', '/articles', '/faq', '/nav', '/admin'];
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(function(){
  var out = { unnamed: [], noAlt: [], emptyBtn: [], headingJumps: [], total: { controls: 0, imgs: 0, buttons: 0 } };
  var ctrls = document.querySelectorAll('input:not([type=hidden]), select, textarea');
  for (var i = 0; i < ctrls.length; i++) {
    var el = ctrls[i];
    out.total.controls++;
    var name = (el.getAttribute('aria-label') || '').trim();
    if (!name && el.id) {
      var lb = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
      if (lb) name = (lb.textContent || '').trim();
    }
    if (!name && el.closest('label')) name = (el.closest('label').textContent || '').trim();
    if (!name) name = (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
    if (!name) {
      var tag = el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '');
      out.unnamed.push(tag + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
    }
  }
  var imgs = document.querySelectorAll('img');
  for (var j = 0; j < imgs.length; j++) {
    out.total.imgs++;
    var img = imgs[j];
    if (!img.hasAttribute('alt')) out.noAlt.push(String(img.getAttribute('src') || '').slice(0, 60));
  }
  var btns = document.querySelectorAll('button, [role=button]');
  for (var k = 0; k < btns.length; k++) {
    out.total.buttons++;
    var b = btns[k];
    var t = (b.textContent || '').trim();
    var a = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
    if (!t && !a) out.emptyBtn.push((b.id ? '#' + b.id : b.tagName.toLowerCase()) + (b.className ? '.' + String(b.className).split(' ')[0] : ''));
  }
  var hs = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  var prev = 0;
  for (var m = 0; m < hs.length; m++) {
    var lv = Number(hs[m].tagName.slice(1));
    if (prev && lv - prev > 1) out.headingJumps.push('h' + prev + '→h' + lv + ' ' + (hs[m].textContent || '').trim().slice(0, 24));
    prev = lv;
  }
  return JSON.stringify(out);
})()`;

const port = 9500 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-'));
const proc = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--user-data-dir=' + profile,
  '--remote-debugging-port=' + String(port),
  'about:blank',
], { stdio: 'ignore' });

let ws = null;
let id = 0;
const waits = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const mid = ++id;
  waits.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
});

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    target = list.find((t) => t.type === 'page');
  } catch (e) {}
}
if (!target) { console.error('Chrome 没起来'); proc.kill(); process.exit(1); }

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waits.has(msg.id)) {
    const w = waits.get(msg.id);
    waits.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
  }
};
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
  return r.result && r.result.value;
};

let bad = 0;
try {
  for (const p of PAGES) {
    await send('Page.navigate', { url: BASE + p + (p.includes('?') ? '&' : '?') + 'v=' + Date.now() });
    await sleep(p === '/admin' ? 900 : 2200);
    if (p === '/admin') {
      // 后台要先登录才能量到面板里的控件
      await ev("(function(){var i=document.getElementById('pw'); if(i){i.value='dev'; document.getElementById('loginForm').requestSubmit();} return 'ok';})()");
      await sleep(1600);
    }
    const raw = await ev(PROBE);
    let r = null;
    try { r = JSON.parse(raw); } catch (e) {}
    if (!r) { console.log('FAIL ' + p + '  探测脚本报错: ' + String(raw).slice(0, 80)); bad++; continue; }
    const issues = r.unnamed.length + r.noAlt.length + r.emptyBtn.length + r.headingJumps.length;
    if (issues) bad++;
    console.log(
      (issues ? 'WARN ' : 'OK   ') + p +
      '  控件 ' + r.total.controls + ' / 图片 ' + r.total.imgs + ' / 按钮 ' + r.total.buttons +
      '  无名称 ' + r.unnamed.length + '·无alt ' + r.noAlt.length + '·空按钮 ' + r.emptyBtn.length + '·标题跳级 ' + r.headingJumps.length
    );
    if (r.unnamed.length) console.log('      无名称: ' + r.unnamed.slice(0, 8).join(', '));
    if (r.noAlt.length) console.log('      无 alt: ' + r.noAlt.slice(0, 5).join(', '));
    if (r.emptyBtn.length) console.log('      空按钮: ' + r.emptyBtn.slice(0, 8).join(', '));
    if (r.headingJumps.length) console.log('      跳级: ' + r.headingJumps.slice(0, 5).join(' | '));
  }
} finally {
  try { ws.close(); } catch (e) {}
  proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

console.log(bad === 0 ? '\n无障碍审计全部通过（' + PAGES.length + ' 页 @' + width + 'px）' : '\n' + bad + ' 页有无障碍问题（' + PAGES.length + ' 页 @' + width + 'px）');
process.exit(bad === 0 ? 0 : 1);
