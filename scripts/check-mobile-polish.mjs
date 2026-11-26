// 窄屏细节门禁：390px 下检查 /articles 统计卡是否一行、/faq 问题行是否折行、/ 与 /nav 的联系浮标/副标题
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 390);
const H = 900;

const port = 9800 + Math.floor(Math.random() * 150);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-mpolish-'));
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
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fails.push(name + (detail ? ' :: ' + JSON.stringify(detail) : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result && r.result.result && r.result.result.value;
}
async function go(p) {
  await send('Page.navigate', { url: BASE + p + (p.includes('?') ? '&' : '?') + 'probe=' + Date.now() });
  await sleep(2300);
}

// ---------- /articles ----------
await go('/articles');
const art = await evaluate(`(() => {
  const box = document.querySelector('.bstats');
  const cards = box ? Array.from(box.querySelectorAll('.bstat')) : [];
  const de = document.documentElement;
  return {
    exists: !!box,
    display: box ? getComputedStyle(box).display : '',
    n: cards.length,
    tops: cards.map((c) => Math.round(c.getBoundingClientRect().top)),
    widths: cards.map((c) => Math.round(c.getBoundingClientRect().width)),
    overflow: de.scrollWidth > de.clientWidth + 1,
  };
})()`);
check('文章页有统计卡容器', art && art.exists, art);
check('统计卡窄屏用 grid 布局', art && art.display === 'grid', art && art.display);
check('统计卡 3 张', art && art.n === 3, art && art.n);
check('统计卡在同一行（顶部对齐）', art && new Set(art.tops).size === 1, art && art.tops);
check('统计卡宽度不被挤压（>=100px）', art && art.widths.every((w) => w >= 100), art && art.widths);
check('文章页无横向溢出', art && !art.overflow, art);

// ---------- /faq ----------
await go('/faq');
const faq = await evaluate(`(() => {
  const s = document.querySelector('.qa summary');
  const txt = s && s.querySelector('.qtext');
  const tag = s && s.querySelector('.qtag');
  const link = s && s.querySelector('.qlink');
  const de = document.documentElement;
  const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
  return {
    tracks: s ? getComputedStyle(s).gridTemplateColumns.split(' ').length : 0,
    txtTop: top(txt), tagTop: top(tag), linkTop: top(link),
    overflow: de.scrollWidth > de.clientWidth + 1,
  };
})()`);
check('问答问题行是 3 轨网格', faq && faq.tracks === 3, faq && faq.tracks);
check('问答标签折到第二行', faq && faq.tagTop > faq.txtTop, faq);
check('问答直链折到第二行', faq && faq.linkTop > faq.txtTop, faq);
check('问答页无横向溢出', faq && !faq.overflow, faq);

// ---------- / ----------
await go('/');
const home = await evaluate(`(() => {
  const fab = document.querySelector('.contact-fab');
  const sub = document.querySelector('.brand .sub');
  const de = document.documentElement;
  const cs = fab ? getComputedStyle(fab) : null;
  return {
    fabTop: cs ? cs.top : '',
    gap: fab ? Math.round(window.innerHeight - fab.getBoundingClientRect().bottom) : null,
    fabBottom: cs ? cs.bottom : '',
    clamp: sub ? getComputedStyle(sub).webkitLineClamp : '',
    overflow: de.scrollWidth > de.clientWidth + 1,
  };
})()`);
check('联系浮标竖屏贴底（不再垂直居中挡正文）', home && home.gap !== null && home.gap >= 0 && home.gap <= 40, home);
check('联系浮标仍在视口内', home && home.gap !== null && home.gap > 0, home);
check('品牌副标题最多两行', home && home.clamp === '2', home && home.clamp);
check('首页无横向溢出', home && !home.overflow, home);

// ---------- /nav ----------
await go('/nav');
const nav = await evaluate(`(() => {
  const fab = document.querySelector('.contact-fab');
  const cs = fab ? getComputedStyle(fab) : null;
  const de = document.documentElement;
  return { fabTop: cs ? cs.top : '',
    gap: fab ? Math.round(window.innerHeight - fab.getBoundingClientRect().bottom) : null, overflow: de.scrollWidth > de.clientWidth + 1 };
})()`);
check('导航页联系浮标也在底部', nav && nav.gap !== null && nav.gap >= 0 && nav.gap <= 40, nav);
check('导航页无横向溢出', nav && !nav.overflow, nav);

try { await send('Browser.close'); } catch {}
child.kill();

console.log('');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  fails.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('全部通过（' + pass + ' 项，视口 ' + W + 'px）');
