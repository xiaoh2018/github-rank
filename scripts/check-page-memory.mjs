import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const PORT = 9600 + Math.floor(Math.random() * 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let id = 0; const pending = new Map();
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; break; }
  } catch {}
  await sleep(200);
}
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result && r.result.result ? r.result.result.value : null; };
const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await js(expr)) return true; } catch {} await sleep(120); } return false; };

let pass = 0; let fail = 0;
const check = (label, ok, detail) => { if (ok) { pass += 1; console.log('OK   ' + label + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); } else { fail += 1; console.log('FAIL ' + label + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); } };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE + '/' });
await waitFor("document.querySelectorAll('#list .item').length >= 10", 20000);
await sleep(800);

check('页面有分页器且首屏 20 条', await js("!document.getElementById('pager').hidden && document.querySelectorAll('#list .item:not(.ad-inline)').length === 20"));

const info = () => js("document.getElementById('pageInfo').textContent");
const y = () => js('Math.round(window.scrollY)');

// 1) 第 1 页滚到 900，点下一页 → 第 2 页且回到列表顶
await js('window.scrollTo(0, 900)');
await sleep(200);
const y0 = await y();
await js("document.getElementById('next').click()");
await sleep(900);
const info2 = await info();
const y2 = await y();
check('下一页到第 2 页', /第 2 \//.test(info2), info2);
const topMark = await js("Math.round(document.getElementById('list').getBoundingClientRect().top + window.scrollY - 76)");
check('去没去过的页 → 回列表顶', Math.abs(y2 - topMark) <= 30, { y2, topMark });
check('离开页面的位置被记住', await js("Object.keys(window.__pgY).length >= 1 && Object.values(window.__pgY).some(function(v){return v>120})"), await js('window.__pgY'));

// 2) 点上一页 → 回到第 1 页并恢复位置
await js("document.getElementById('prev').click()");
await sleep(1100);
const y1 = await y();
check('上一页回到第 1 页', /第 1 \//.test(await info()), await info());
check('上一页恢复原来的位置（±40）', Math.abs(y1 - y0) <= 40, { y0, y1 });

// 3) 用「跳到第 N 页」回去也一样
await js("document.getElementById('next').click()");
await sleep(900);
await js("(function(){var e=document.getElementById('pgJump'); e.value='1'; e.dispatchEvent(new Event('change',{bubbles:true}));})()");
await sleep(1100);
check('用页码跳回第 1 页也恢复位置（±40）', Math.abs((await y()) - y0) <= 40, { y0, y1: await y() });

// 4) 换排序后记忆不串（key 含排序）
await js("(function(){var s=document.getElementById('sort'); s.value='forks'; s.dispatchEvent(new Event('change',{bubbles:true}));})()");
await sleep(1200);
const afterSort = await y();
const sortTop = await js("Math.round(document.getElementById('list').getBoundingClientRect().top + window.scrollY - 76)");
check('换排序后回到列表顶（不串位置）', Math.abs(afterSort - sortTop) <= 30, { afterSort, sortTop });
check('排序后仍在第 1 页', /第 1 \//.test(await info()));

// 5) 记忆只在内存里，不落 localStorage
const lsKeys = await js('Object.keys(localStorage)');
check('位置记忆不写 localStorage', !lsKeys.some((k) => /pgY|pageY|scroll/.test(k)), lsKeys);

// 6) 390 也成立
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: BASE + '/' });
await waitFor("document.querySelectorAll('#list .item').length >= 10", 20000);
await sleep(900);
await js("(function(){var s=document.getElementById('sort'); s.value='stars'; s.dispatchEvent(new Event('change',{bubbles:true}));})()");
await sleep(1200);
await js('window.scrollTo(0, 700)');
await sleep(250);
const my0 = await y();
await js("document.getElementById('next').click()");
await sleep(1000);
await js("document.getElementById('prev').click()");
await sleep(1100);
check('390：上一页回到第 1 页', /第 1 \//.test(await info()));
check('390：恢复位置（±40）', Math.abs((await y()) - my0) <= 40, { my0, now: await y() });
check('390：不横向溢出', await js('document.documentElement.scrollWidth === document.documentElement.clientWidth'));

console.log('\n' + (fail === 0 ? 'ALL OK (' + pass + ')' : 'FAILED ' + fail + ' / ' + (pass + fail)) + '  @' + BASE);
ws.close(); proc.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);