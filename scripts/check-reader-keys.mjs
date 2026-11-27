// 阅读器进度条门禁：
//  1. 短文 / 页面几乎不能滚时，进度条应该隐藏（不是永远停在 0%）
//  2. 长正文时进度条要随滚动前进，到顶 0%、到底接近 100%
//  3. End / Home 键要把页面带到对应位置，Esc 能关掉阅读器
// 用法：先起 dev-server（8123），再 node scripts/check-reader-keys.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const W = Number(process.env.W || 1000);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 10090 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-keys-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

let target;
for (let i = 0; i < 40 && !target; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const key = (k) => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
const bar = () => js(`(() => { var b = document.getElementById('rprogress'); return b ? { hidden: b.hidden, w: parseFloat(b.style.width) || 0 } : null; })()`);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 620, deviceScaleFactor: 1, mobile: false });

console.log('== 阅读器进度条 ==');
await send('Page.navigate', { url: base + '/articles?v=' + Date.now() });
await sleep(2600);
const opened = await js(`(() => { var c = document.querySelector('#cards .acard'); if (!c) return { ok: false }; c.click(); return { ok: true }; })()`);
await sleep(1200);
const vis = await js(`(() => { var r = document.getElementById('reader'); return r ? !r.hidden : false; })()`);
ok('点卡片能打开阅读器', !!(opened && opened.ok) && vis === true, JSON.stringify({ opened, vis }));

// 短文：页面几乎不能滚 → 进度条应当隐藏，而不是停在 0%
const shortState = await js(`(() => {
  var maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  var b = document.getElementById('rprogress');
  return { maxY: Math.round(maxY), hidden: b ? b.hidden : null };
})()`);
ok('短文（页面几乎不能滚）时进度条隐藏', !!shortState && shortState.hidden === true, JSON.stringify(shortState));

// 换成超长正文：进度条必须出现并随滚动走
await js(`(() => {
  var ab = document.querySelector('#reader .abody');
  if (!ab) return 'no-abody';
  var p = document.createElement('p');
  p.textContent = '这是一段用来把页面撑长的测试正文。'.repeat(120);
  ab.innerHTML = '<h3>长正文</h3>' + p.outerHTML;
  window.dispatchEvent(new Event('resize'));
  return 'ok';
})()`);
await sleep(400);
await js(`window.scrollTo(0, 0)`);
await sleep(500);
const atTop = await bar();
ok('长正文时进度条出现', !!atTop && atTop.hidden === false, JSON.stringify(atTop));
ok('停在顶部时进度接近 0%', !!atTop && atTop.w <= 5, JSON.stringify(atTop));

const maxY = await js(`Math.max(0, document.documentElement.scrollHeight - window.innerHeight)`);
await js(`window.scrollTo(0, Math.round(${maxY} / 2))`);
await sleep(600);
const mid = await bar();
ok('滚到中间时进度在 20%~90%', !!mid && mid.w > 20 && mid.w < 90, JSON.stringify({ mid, maxY }));

await js(`window.scrollTo(0, ${maxY})`);
await sleep(600);
const bottom = await bar();
ok('滚到底时进度 ≥ 95%', !!bottom && bottom.w >= 95, JSON.stringify({ bottom, maxY }));

await js(`window.scrollTo(0, 0)`);
await sleep(400);
await key('End');
await sleep(1200);
const endY = await js(`Math.round(window.scrollY)`);
ok('按 End 跳到页面底部', typeof endY === 'number' && endY >= Math.round(maxY) - 4, JSON.stringify({ endY, maxY }));
const barEnd = await bar();
ok('按 End 后进度条接近满格', !!barEnd && barEnd.w >= 95, JSON.stringify(barEnd));

await key('Home');
await sleep(1200);
// Home 的语义是「回到正文开头」而不是「页面最顶」：articles.html 里滚到 r.offsetTop - 24
const homeState = await js(`(() => { var r = document.getElementById('reader'); return { y: Math.round(window.scrollY), want: Math.max(0, Math.round((r ? r.offsetTop : 0) - 24)) }; })()`);
ok('按 Home 回到正文开头', !!homeState && Math.abs(homeState.y - homeState.want) <= 6, JSON.stringify(homeState));
const barHome = await bar();
ok('按 Home 后进度条回到 0%', !!barHome && barHome.w <= 5, JSON.stringify(barHome));

await key('Escape');
await sleep(900);
const closed = await js(`(() => { var r = document.getElementById('reader'); var b = document.getElementById('rprogress'); return { readerHidden: r ? r.hidden : null, barHidden: b ? b.hidden : null }; })()`);
ok('Esc 关闭阅读器', !!closed && closed.readerHidden === true, JSON.stringify(closed));
ok('关闭后进度条隐藏', !!closed && closed.barHidden === true, JSON.stringify(closed));

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
ws.close();
child.kill();
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
