// 动效降级门禁：开启 prefers-reduced-motion 后，卡片入场动画与平滑滚动都应被关掉。
// 用法：先起 dev-server（8123），再 node scripts/check-motion.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9930 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-motion-'));
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
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const open = async (p) => { await send('Page.navigate', { url: base + p + '?v=' + Date.now() }); await sleep(2400); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const probe = `(() => {
  const el = document.querySelector('#list .item:not(.empty-item)') || document.querySelector('.artcard') || document.querySelector('.qa') || document.body;
  const cs = getComputedStyle(el);
  return {
    tag: el.className || el.tagName,
    anim: cs.animationDuration,
    trans: cs.transitionDuration,
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
  };
})()`;

for (const page of ['/', '/articles', '/faq']) {
  console.log('== ' + page + ' ==');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await open(page);
  const r = await evalJs(probe);
  const ms = (v) => { const n = parseFloat(String(v || '0')); return isNaN(n) ? 0 : (String(v).indexOf('ms') >= 0 ? n : n * 1000); };
  const animOff = !r || Math.max(ms(r.anim), ms(r.trans)) <= 0.01;
  ok(page + ' 关闭动画', animOff, JSON.stringify(r));
  ok(page + ' 关闭过渡', !r || ms(r.trans) <= 0.01, JSON.stringify(r));
  ok(page + ' 平滑滚动被关掉', !r || r.scrollBehavior === 'auto', JSON.stringify(r));

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await open(page);
  const normal = await evalJs(probe);
  ok(page + ' 未开启时仍有动效（或本来就无动效）', !!normal && !normal.__err, JSON.stringify(normal));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\n全部通过');
try { ws.close(); } catch {}
try { child.kill(); } catch {}
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
