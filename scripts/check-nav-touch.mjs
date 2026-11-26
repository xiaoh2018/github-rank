import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 320);
const H = Number(process.argv[3] || 568);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9500 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-nt-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  if (!page) await sleep(200);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const myId = ++id; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((r) => pending.set(myId, r)); };
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const v = r.result && r.result.result; return v ? v.value : undefined; };

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass }); console.log((pass ? 'OK   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 761 });
await send('Page.navigate', { url: BASE + '/nav?t=' + Date.now() });
await sleep(3000);

const m = JSON.parse(await ev(`(() => {
  const togs = [...document.querySelectorAll('.navgroup .gtog')].map((b) => Math.round(b.getBoundingClientRect().height));
  const pills = [...document.querySelectorAll('.nj')].map((b) => Math.round(b.getBoundingClientRect().height));
  const icl = document.querySelector('.navcard .icw .ic-l');
  const vw = document.documentElement.clientWidth;
  return JSON.stringify({
    togCount: togs.length, togMin: Math.min(...togs), togMax: Math.max(...togs),
    pillCount: pills.length, pillMin: pills.length ? Math.min(...pills) : 0,
    icFont: icl ? parseFloat(getComputedStyle(icl).fontSize) : 0,
    over: document.documentElement.scrollWidth > vw, vw, sw: document.documentElement.scrollWidth,
  });
})()`));

check('导航分组折叠按钮 ≥40px 高', m.togCount > 0 && m.togMin >= 40, m.togCount + ' 个，最矮 ' + m.togMin + 'px');
check('站点胶囊 ≥34px 高', m.pillCount > 0 && m.pillMin >= 34, m.pillCount + ' 个，最矮 ' + m.pillMin + 'px');
check('图标首字母 ≥11px', m.icFont >= 11, m.icFont + 'px');
check('没有横向溢出', !m.over, 'vw=' + m.vw + ' sw=' + m.sw);

const before = await ev(`document.querySelector('.navgroup .gtog').getAttribute('aria-expanded')`);
await ev(`document.querySelector('.navgroup .gtog').click()`);
await sleep(280);
const after = await ev(`(() => { const g = document.querySelector('.navgroup'); return JSON.stringify({ exp: g.querySelector('.gtog').getAttribute('aria-expanded'), closed: g.classList.contains('is-closed'), items: g.querySelectorAll('.nj').length }); })()`);
const a = JSON.parse(after);
check('点一下真的收起（aria-expanded 跟随）', before !== a.exp && a.closed, before + ' -> ' + a.exp);
await ev(`document.querySelector('.navgroup .gtog').click()`);
await sleep(250);
check('再点一下展开回来', JSON.parse(await ev(`(() => { const g = document.querySelector('.navgroup'); return JSON.stringify({ exp: g.querySelector('.gtog').getAttribute('aria-expanded'), closed: g.classList.contains('is-closed') }); })()`)).exp === before, '');

// 320 下四个前台页面都不许横向溢出（这一轮顺手把整站最窄宽度也钉住）
for (const p of ['/', '/articles', '/faq']) {
  await send('Page.navigate', { url: BASE + p + (p.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now() });
  await sleep(2600);
  const o = JSON.parse(await ev(`(() => { const vw = document.documentElement.clientWidth; return JSON.stringify({ vw, sw: document.documentElement.scrollWidth }); })()`));
  check(p + ' 在 ' + W + 'px 下没有横向溢出', o.sw <= o.vw + 1, 'vw=' + o.vw + ' sw=' + o.sw);
}

// 页头 5 个胶囊在窄屏要排成整齐的行（不是「4 个 + 1 个孤儿」）
await send('Page.navigate', { url: BASE + '/?h=' + Date.now() });
await sleep(2600);
const head = JSON.parse(await ev(`(() => {
  const btns = [...document.querySelectorAll('.head-actions .btn')];
  const rows = {};
  btns.forEach((b) => { const r = b.getBoundingClientRect(); const k = Math.round(r.top / 4); rows[k] = (rows[k] || 0) + 1; });
  const ws = btns.map((b) => Math.round(b.getBoundingClientRect().width));
  return JSON.stringify({ n: btns.length, rows: Object.values(rows), min: Math.min(...ws), max: Math.max(...ws), over: document.documentElement.scrollWidth > document.documentElement.clientWidth });
})()`));
if (W <= 380) {
  check('页头 5 个胶囊都在', head.n === 5, 'n=' + head.n);
  check('窄屏排成 2 行（不是 4+1 孤儿）', head.rows.length === 2 && head.rows[0] === 3 && head.rows[1] === 2, JSON.stringify(head.rows));
  check('五个胶囊宽度一致（网格等宽）', head.max - head.min <= 3, head.min + '~' + head.max);
  check('页头不溢出', !head.over, '');
} else {
  console.log('（' + W + 'px > 380，页头仍用弹性换行，跳过网格断言）');
}
const failed = results.filter((x) => !x.pass);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL OK (' + results.length + ' 项，' + W + 'px)'));
try { await send('Browser.close'); } catch {}
child.kill();
process.exit(failed.length ? 1 : 0);