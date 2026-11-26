// 后台窄屏门禁（第二轮）：①提交页 4 列平台表在 390px 下变成堆叠卡片（带列名）②复制框上下排 ③侧栏横向滚动两端渐隐提示 ④整页不溢出
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 390);

const port = 9500 + Math.floor(Math.random() * 120);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-npan-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  try { const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = list.find((t) => t.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const myId = ++id; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((res) => pending.set(myId, res)); };
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: BASE + '/admin' });
await sleep(2600);
await ev(`(() => { const p = document.getElementById('pw'); if (p) p.value = 'dev'; document.getElementById('loginForm').requestSubmit(); return 1; })()`);
await sleep(2600);

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) pass++;
  else { fails.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); console.log('  FAIL  ' + name + ' :: ' + JSON.stringify(detail)); }
}

// ① 侧栏横向滚动：起始 / 末尾 / 回到开头
// 注意：scroll-snap 会把程序化滚动吸回对齐点，断言前临时关掉（只影响测试，不改产品行为）
const sideStart = await ev(`(() => {
  const s = document.querySelector('.side');
  if (!s) return { err: 'no side' };
  s.style.scrollSnapType = 'none';
  s.scrollLeft = 0;
  if (window.__paintSide) window.__paintSide();
  const cs = getComputedStyle(s);
  return {
    overflow: cs.overflowX,
    canScroll: s.scrollWidth - s.clientWidth > 4,
    mask: String(cs.maskImage || ''),
    xEnd: s.classList.contains('x-end'),
    xStart: s.classList.contains('x-start'),
  };
})()`);
check('侧栏可横向滚动', sideStart && sideStart.canScroll === true, sideStart);
check('侧栏在起始处：右缘渐隐（mask 含 calc(100% - 24px)）', sideStart && /calc\(100%/.test(sideStart.mask), sideStart && sideStart.mask);
check('侧栏在起始处：左缘不渐隐（x-start 为假）', sideStart && sideStart.xStart === false, sideStart && sideStart.xStart);

const sideEnd = await ev(`(() => {
  const s = document.querySelector('.side');
  s.style.scrollSnapType = 'none';
  s.scrollLeft = s.scrollWidth;
  if (window.__paintSide) window.__paintSide();
  const cs = getComputedStyle(s);
  return { xEnd: s.classList.contains('x-end'), xStart: s.classList.contains('x-start'), mask: String(cs.maskImage || ''), left: s.scrollLeft };
})()`);
check('划到末尾后加 x-end', sideEnd && sideEnd.xEnd === true, sideEnd);
check('划到末尾后右缘不再渐隐（mask 不含 calc(100% - 24px)）', sideEnd && !/calc\(100%/.test(sideEnd.mask), sideEnd && sideEnd.mask);
check('划到末尾时左缘渐隐（x-start）', sideEnd && sideEnd.xStart === true, sideEnd);

const sideBack = await ev(`(() => {
  const s = document.querySelector('.side');
  s.style.scrollSnapType = 'none';
  s.scrollLeft = 0;
  if (window.__paintSide) window.__paintSide();
  return { xStart: s.classList.contains('x-start'), xEnd: s.classList.contains('x-end'), left: s.scrollLeft };
})()`);
check('划回开头后 x-start 撤掉', sideBack && sideBack.xStart === false, sideBack);

// ② 提交页平台表堆叠
await ev(`(() => { const b = document.querySelector('.nav[data-tab="submit"]'); if (b) b.click(); return 1; })()`);
await sleep(900);

const plat = await ev(`(() => {
  const pane = document.getElementById('pane-submit');
  const tb = pane.querySelector('.geo-plat');
  if (!tb) return { err: 'no table' };
  const head = getComputedStyle(tb.querySelector('thead')).display;
  const tr = tb.querySelector('tbody tr');
  const tds = Array.from(tr.querySelectorAll('td'));
  const tops = tds.map((td) => Math.round(td.getBoundingClientRect().top));
  const trRect = tr.getBoundingClientRect();
  const csTr = getComputedStyle(tr);
  const innerW = Math.round(trRect.width - parseFloat(csTr.paddingLeft) - parseFloat(csTr.paddingRight));
  const tdW = tds.map((td) => Math.round(td.getBoundingClientRect().width));
  const lab2 = getComputedStyle(tds[1], '::before').content;
  const lab3 = getComputedStyle(tds[2], '::before').content;
  const lab4 = getComputedStyle(tds[3], '::before').content;
  return { head, trDisplay: csTr.display, rows: tb.querySelectorAll('tbody tr').length, tds: tds.length, tops, trW: Math.round(trRect.width), innerW, tdW, lab2, lab3, lab4 };
})()`);
check('平台表在窄屏隐藏表头', plat && plat.head === 'none', plat && plat.head);
check('平台表每行变块级卡片', plat && plat.trDisplay === 'block', plat && plat.trDisplay);
check('平台表仍是 6 行 / 每行 4 列', plat && plat.rows === 6 && plat.tds === 4, plat && { rows: plat.rows, tds: plat.tds });
check('4 个格子竖直堆叠（top 递增）', plat && plat.tops.every((t, i, a) => i === 0 || t > a[i - 1]), plat && plat.tops);
check('格子宽度 = 卡片内容宽度（不拥挤）', plat && plat.tdW.every((w) => Math.abs(w - plat.innerW) <= 2), plat && { tdW: plat.tdW, innerW: plat.innerW });
check('第 2/3/4 列有中文列名前缀', plat && /要做什么/.test(plat.lab2) && /要填的参数/.test(plat.lab3) && /能一键吗/.test(plat.lab4), plat && [plat.lab2, plat.lab3, plat.lab4]);

const copy = await ev(`(() => {
  const pane = document.getElementById('pane-submit');
  const box = pane.querySelector('.copybox');
  const in1 = box.querySelector('input');
  const btn = box.querySelector('button');
  const cs = getComputedStyle(box);
  const a = in1.getBoundingClientRect(), b = btn.getBoundingClientRect(), c = box.getBoundingClientRect();
  return { dir: cs.flexDirection, inputW: Math.round(a.width), boxW: Math.round(c.width), btnTop: Math.round(b.top), inBottom: Math.round(a.bottom) };
})()`);
check('复制框窄屏上下排（column）', copy && copy.dir === 'column', copy && copy.dir);
check('复制框输入框撑满', copy && Math.abs(copy.inputW - copy.boxW) <= 2, copy && [copy.inputW, copy.boxW]);
check('复制按钮在输入框下方', copy && copy.btnTop >= copy.inBottom - 2, copy && [copy.btnTop, copy.inBottom]);

// ③ 整页不溢出
const doc = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
check('后台整页在 ' + W + 'px 下不横向溢出', doc && doc.sw <= doc.cw + 1, doc);

try { await send('Browser.close'); } catch {}
child.kill();

console.log('');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  fails.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('全部通过（' + pass + ' 项，视口 ' + W + 'px）');
