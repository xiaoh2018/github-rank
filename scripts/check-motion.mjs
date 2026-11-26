// 尊重系统「减少动态效果」：开了 reduce 时，动画/过渡/平滑滚动都必须让开
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.env.PROBE_W || 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const port = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-motion-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  if (!target) await sleep(150);
}
if (!target) { console.error('no cdp page'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result && r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.text) + ' / ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || ''));
  return r.result && r.result.result ? r.result.result.value : undefined;
};

const rows = [];
const push = (name, ok, extra) => { rows.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 700 });

async function open(url, reduce, wait = 2200) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 't=' + Date.now() });
  await sleep(wait);
}

// ---------- A. reduce 下的四个页面 ----------
await open(BASE + '/', true, 2600);
push('reduce 生效（matchMedia 为 true）', await ev("matchMedia('(prefers-reduced-motion: reduce)').matches === true"));
push('首页 html 的 scroll-behavior 变 auto', (await ev("getComputedStyle(document.documentElement).scrollBehavior")) === 'auto');
push('首页滚动助手返回 auto', (await ev("typeof window.__sb === 'function' && window.__sb()")) === 'auto');
const itemDur = await ev("(function(){var el=document.querySelector('#list .item');return el?getComputedStyle(el).animationDuration:'none';})()");
push('首页卡片不再入场动画（时长 ≤ 0.02s）', itemDur !== 'none' ? parseFloat(itemDur) <= 0.02 : true, itemDur);
const tkDur = await ev("(function(){var el=document.querySelector('.ad-ticker .tk-in');return el?getComputedStyle(el).animationName:'none';})()");
push('滚动条不再无休止滚动', tkDur === 'none', tkDur);

await open(BASE + '/articles', true, 2400);
push('文章页 html 的 scroll-behavior 变 auto', (await ev("getComputedStyle(document.documentElement).scrollBehavior")) === 'auto');
const cardTr = await ev("(function(){var el=document.querySelector('.acard');return el?getComputedStyle(el).transitionDuration:'none';})()");
push('文章卡不再做过渡（时长 ≤ 0.02s）', cardTr !== 'none' ? parseFloat(cardTr) <= 0.02 : true, cardTr);

await open(BASE + '/faq', true, 2400);
push('问答页 html 的 scroll-behavior 变 auto', (await ev("getComputedStyle(document.documentElement).scrollBehavior")) === 'auto');

await open(BASE + '/admin', true, 2600);
const btnTr = await ev("(function(){var b=document.querySelector('button');return b?getComputedStyle(b).transitionDuration:'none';})()");
push('后台按钮不再做过渡（时长 ≤ 0.02s）', btnTr !== 'none' ? parseFloat(btnTr) <= 0.02 : true, btnTr);

// ---------- B. 真实滚动行为（reduce 应立即到底） ----------
await open(BASE + '/', true, 2600);
await ev('window.scrollTo(0, 1400); 1');
await sleep(120);
const beforeY = await ev('Math.round(window.scrollY)');
await ev("(function(){var b=document.getElementById('top'); if(b) b.click(); return 1;})()");
await sleep(90);
const fastY = await ev('Math.round(window.scrollY)');
push('reduce 下点「回到顶部」立即到位（≤ 24px）', beforeY > 400 && fastY <= 24, { beforeY, fastY });

// ---------- C. 默认（no-preference）仍要有动效 ----------
await open(BASE + '/', false, 2600);
push('默认设置下 matchMedia 为 false', await ev("matchMedia('(prefers-reduced-motion: reduce)').matches === false"));
push('默认设置下滚动助手返回 smooth', (await ev("window.__sb && window.__sb()")) === 'smooth');
const dur2 = await ev("(function(){var el=document.querySelector('#list .item');return el?getComputedStyle(el).animationDuration:'none';})()");
push('默认设置下卡片仍有入场动画（> 0.1s）', dur2 !== 'none' && parseFloat(dur2) > 0.1, dur2);
await ev('window.scrollTo(0, 1400); 1');
await sleep(120);
const y0 = await ev('Math.round(window.scrollY)');
await ev("(function(){var b=document.getElementById('top'); if(b) b.click(); return 1;})()");
await sleep(90);
const y1 = await ev('Math.round(window.scrollY)');
push('默认设置下是平滑滚动（90ms 时仍在路上）', y0 > 400 && y1 > 60, { y0, y1 });

ws.close();
try { child.kill(); } catch {}
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + '/' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + W + 'px  ' + BASE);
process.exit(bad.length ? 1 : 0);
