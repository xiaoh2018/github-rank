// 后台窄屏门禁：390px 下 ①命令面板有可点的浮动入口并能打开/关闭 ②点 tab 后侧栏会把当前项滚进可视区 ③文章阅读器窄屏标题字号
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 390);

const port = 9900 + Math.floor(Math.random() * 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-madmin-'));
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => {
  const myId = ++id;
  ws.send(JSON.stringify({ id: myId, method, params }));
  return new Promise((res) => pending.set(myId, res));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 844, deviceScaleFactor: 1, mobile: true });

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fails.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); console.log('  FAIL  ' + name + ' :: ' + JSON.stringify(detail)); }
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result && r.result.result.value;
}

// ---------- 后台 ----------
await send('Page.navigate', { url: BASE + '/admin' });
await sleep(2600);
await evaluate(`(() => { const p = document.getElementById('pw'); if (p) p.value = 'dev'; const f = document.getElementById('loginForm'); if (f) f.requestSubmit(); return 1; })()`);
await sleep(2600);

const fab = await evaluate(`(() => {
  const b = document.getElementById('cmdkFab');
  if (!b) return { exists: false };
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  return {
    exists: true, display: cs.display, w: Math.round(r.width), h: Math.round(r.height),
    inView: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
    bottomGap: Math.round(window.innerHeight - r.bottom),
  };
})()`);
check('后台有命令面板浮动入口', fab && fab.exists, fab);
check('浮动入口在窄屏可见', fab && fab.display !== 'none', fab && fab.display);
check('浮动入口尺寸够点（44+）', fab && fab.w >= 44 && fab.h >= 44, fab);
check('浮动入口在视口内且贴底（离底 0–40）', fab && fab.inView && fab.bottomGap >= 0 && fab.bottomGap <= 40, fab);

const opened = await evaluate(`(() => {
  const b = document.getElementById('cmdkFab');
  b.click();
  const d = document.getElementById('cmdk');
  const list = document.getElementById('ckList');
  const rows = list ? Array.from(list.querySelectorAll('.ck-item')) : [];
  return {
    open: d.hasAttribute('open'),
    items: rows.length,
    raw: rows.filter((r) => {
      const name = (r.querySelector('span') || {}).textContent || '';
      const key = (r.querySelector('small') || {}).textContent || '';
      return name.trim() === key.trim();
    }).map((r) => (r.querySelector('small') || {}).textContent),
  };
})()`);
check('点浮动入口能打开命令面板', opened && opened.open, opened);
check('命令面板列出了可跳转项', opened && opened.items >= 10, opened);
check('每项都有中文名（没有裸 key）', opened && opened.raw.length === 0, opened && opened.raw);

const closed = await evaluate(`(() => {
  const d = document.getElementById('cmdk');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { open: d.hasAttribute('open') };
})()`);
check('Esc 能关掉命令面板', closed && !closed.open, closed);

// 点最后一个 tab（侧栏窄屏是横向滚动，默认看不到），验证会自动滚进可视区
const scroll = await evaluate(`(() => {
  const side = document.querySelector('.side');
  const tabs = Array.from(document.querySelectorAll('.nav'));
  const last = tabs[tabs.length - 1];
  const before = { left: Math.round(last.getBoundingClientRect().left) };
  last.click();
  const sr = side.getBoundingClientRect();
  const r = last.getBoundingClientRect();
  return {
    tab: last.getAttribute('data-tab'),
    visible: r.left >= sr.left - 2 && r.right <= sr.right + 2,
    sideScroll: side.scrollWidth > side.clientWidth,
    aria: last.getAttribute('aria-current'),
    before,
  };
})()`);
check('侧栏在窄屏是横向滚动', scroll && scroll.sideScroll, scroll);
check('点到的 tab 被滚进可视区', scroll && scroll.visible, scroll);
check('该 tab 标为当前页', scroll && scroll.aria === 'true', scroll && scroll.aria);

// ---------- 文章阅读器窄屏 ----------
await send('Page.navigate', { url: BASE + '/articles/cat/1.html' });
await sleep(2600);
const reader = await evaluate(`(() => {
  const h = document.querySelector('.reader h1');
  const de = document.documentElement;
  return {
    size: h ? getComputedStyle(h).fontSize : '',
    overflow: de.scrollWidth > de.clientWidth + 1,
  };
})()`);
check('阅读器标题窄屏 23px', reader && reader.size === '23px', reader && reader.size);
check('阅读器窄屏不横向溢出', reader && !reader.overflow, reader);

try { await send('Browser.close'); } catch {}
child.kill();

console.log('');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  fails.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('全部通过（' + pass + ' 项，视口 ' + W + 'px）');
