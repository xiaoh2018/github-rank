// 门禁：模态打开时背景不能滚 + 关闭后恢复 + 图片查看器必须是原生 dialog
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9500 + Math.floor(Math.random() * 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
let ws, id = 0;
const pending = new Map();
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
      break;
    }
  } catch {}
  await sleep(200);
}
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result && r.result.result ? r.result.result.value : null;
};
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('OK   ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

await send('Page.enable');
await send('Runtime.enable');
const W = Number(process.env.W || 1440), H = Number(process.env.H || 900);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 800 });

// --- 后台：写文章弹窗 ---
await send('Page.navigate', { url: BASE + '/admin' }); await sleep(900);
await js("sessionStorage.setItem('adminPw','dev')");
await send('Page.navigate', { url: BASE + '/admin' }); await sleep(2300);
check('后台登录成功（侧栏出现）', await js("!!document.querySelector('.side .nav')"));

const open = await js(`(function(){
  var errs = [];
  window.addEventListener('error', function(e){ errs.push(String(e.message)); });
  var b = document.getElementById('artNew');
  if (!b) return { errs: ['no #artNew'], ok: false };
  b.scrollIntoView({ block: 'center', behavior: 'instant' });
  b.click();
  return { errs: errs, ok: !!document.getElementById('artDlg') && document.getElementById('artDlg').open };
})()`);
check('「写文章」弹窗能打开', open && open.ok === true, open);

const wheel = async (y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(W / 2), y: Math.round(H / 2), deltaX: 0, deltaY: y });
  await sleep(420);
};
const y0 = await js('window.scrollY');
await wheel(400);
const locked = { y0: y0, y1: await js('window.scrollY'), overflow: await js("getComputedStyle(document.documentElement).overflow"), bodyOverflow: await js("getComputedStyle(document.body).overflow") };
check('弹窗打开时 html 与 body 的 overflow 都是 hidden', locked && locked.overflow === 'hidden' && locked.bodyOverflow === 'hidden', locked && { h: locked.overflow, b: locked.bodyOverflow });
check('弹窗打开时 html overflow 是 hidden', locked && locked.overflow === 'hidden', locked && locked.overflow);
check('弹窗打开时滚轮推不动背景（真实滚轮事件）', locked && locked.y1 === locked.y0, locked && { y0: locked.y0, y1: locked.y1 });

await js("(function(){var x=document.querySelector('[data-close=\"artDlg\"]'); if(x) x.click(); else document.getElementById('artDlg').close();})()");
await sleep(320);
const closedOpen = await js("(function(){var d=document.getElementById('artDlg'); return { open: d ? d.open : null, overflow: getComputedStyle(document.documentElement).overflow, bodyOverflow: getComputedStyle(document.body).overflow }; })()");
check('关闭后 overflow 恢复', closedOpen && closedOpen.open === false && closedOpen.overflow !== 'hidden' && closedOpen.bodyOverflow !== 'hidden', closedOpen);
await wheel(260);
check('关闭后滚轮能重新滚背景', (await js('window.scrollY')) > 0, { y: await js('window.scrollY') });

// --- 前台：图片查看器必须是 <dialog> ---
await send('Page.navigate', { url: BASE + '/articles' }); await sleep(2200);
const lb = await js(`(function(){
  var el = document.getElementById('lightbox');
  return { tag: el ? el.tagName : null, hasImg: !!(el && el.querySelector('#lbImg')), modal: !!(el && el.showModal) };
})()`);
check('图片查看器是原生 DIALOG（自带焦点陷阱与背景锁）', lb && lb.tag === 'DIALOG', lb);
check('图片查看器里有 #lbImg', lb && lb.hasImg === true, lb && lb.hasImg);
check('图片查看器有 showModal 方法', lb && lb.modal === true, lb && lb.modal);

const lbOpen = await js(`(function(){
  var el = document.getElementById('lightbox');
  el.querySelector('#lbImg').src = '/og-image.png';
  el.querySelector('#lbImg').hidden = false;
  document.body.classList.add('lb-open');
  el.showModal();
  return { open: el.open, y0: 0, y1: 0 };
})()`);
check('showModal 打开图片查看器', lbOpen && lbOpen.open === true, lbOpen && lbOpen.open);
check('图片查看器打开时背景 overflow 被锁', (await js("getComputedStyle(document.body).overflow")) === 'hidden', await js("getComputedStyle(document.body).overflow"));
await wheel(300);
check('图片查看器打开时滚轮推不动背景', (await js('window.scrollY')) === 0, { y: await js('window.scrollY') });

await js("document.getElementById('lbClose').click();");
await sleep(260);
const lbClosed = await js("(function(){var el=document.getElementById('lightbox'); return { open: el.open, bodyOverflow: getComputedStyle(document.body).overflow, lbOpen: document.body.classList.contains('lb-open') }; })()");
check('关闭图片查看器后 body 恢复（lb-open 撤掉）', lbClosed && lbClosed.open === false && lbClosed.bodyOverflow !== 'hidden' && lbClosed.lbOpen === false, lbClosed);
const tall = await js('document.body.scrollHeight > innerHeight + 40');
await wheel(240);
check('关闭图片查看器后背景不再被锁（页面够高时能滚）', (await js('getComputedStyle(document.body).overflow')) !== 'hidden' && (tall ? (await js('window.scrollY')) > 0 : true), { tall: tall, y: await js('window.scrollY') });

const over = await js(`({ vw: innerWidth, sw: document.documentElement.scrollWidth })`);
check('不横向溢出', over && over.sw <= over.vw + 1, over);

ws.close(); proc.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('\n' + (fail === 0 ? 'ALL OK (' + pass + ')' : 'FAILED ' + fail + ' / ' + (pass + fail)) + '  @' + W + 'px  ' + BASE);
process.exit(fail === 0 ? 0 : 1);