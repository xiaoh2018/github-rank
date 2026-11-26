// 门禁：后台「顶部滚动条」分区 —— 说明写清影响范围，填错了当场提醒（不用等保存失败）
// 用法：node scripts/check-ticker-ui.mjs            （本地 dev-server，密码 dev）
//       PROBE_BASE=… 时只跑只读项（本门禁全部可本地跑，线上跳过写操作不存在，故 PROBE_BASE 仍可跑）
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/$/, '');
const PW = process.env.ADMIN_PW || 'dev';
const W = Number(process.env.W || 1440);
const PORT = 9400 + Math.floor(Math.random() * 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };
const waitFor = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await js(expr)) === true) return true; await sleep(150); } return false; };
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('OK   ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

for (let i = 0; i < 80; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; break; } } catch {}
  await sleep(200);
}
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W <= 430 });

// 登录（拿 token 直接进，不点表单，避免受登录动画影响）
await send('Page.navigate', { url: BASE + '/admin?t=' + Date.now() });
await waitFor("!!document.getElementById('gate')");
await js('sessionStorage.setItem("adminPw",' + JSON.stringify(PW) + ')');
await send('Page.reload', { ignoreCache: true });
await waitFor("!!document.getElementById('app') && getComputedStyle(document.getElementById('gate')).display === 'none'", 20000);
await js("(function(){var n=[].slice.call(document.querySelectorAll('.side .nav')).filter(function(b){return /广告/.test(b.textContent)});if(!n.length)return false;n[0].click();return true;})()");
await sleep(600);
const opened = await js("(function(){var p=document.getElementById('pane-ad');return !!p && p.hidden===false && p.dataset.sec==='fixed';})()");
check('广告面板打开（默认固定位分区）', opened === true);
await js("document.querySelector('[data-adsec=\"ticker\"]').click()");
await sleep(400);
const secOn = await js("(function(){var p=document.getElementById('pane-ad');return {sec:p.dataset.sec, shown:getComputedStyle(document.querySelector('.ticker-card')).display!=='none'};})()");
check('切到「顶部滚动条」分区', secOn && secOn.sec === 'ticker' && secOn.shown === true, secOn);

const desc = String(await js("(document.querySelector('.ticker-card .desc')||{}).textContent || ''"));
check('说明写清出现范围（首页与导航页，并点明文章/问答页没有）', /首页与导航页的顶部/.test(desc) && /文章页、问答页是独立页面/.test(desc), desc.slice(0, 90));

const initWarn = await js("(function(){var w=document.getElementById('tickerWarn');return {exists:!!w, hidden:w?w.hidden:null};})()");
check('有就地提醒位，且关闭状态下默认隐藏', initWarn.exists === true && initWarn.hidden === true, initWarn);

// 开启 + 空文案
await js("(function(){var e=document.getElementById('ticker-enabled');e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));})()");
await sleep(200);
const w1 = await js("(function(){var w=document.getElementById('tickerWarn');return {hidden:w.hidden,txt:w.textContent};})()");
check('开启但没写文案 → 提醒要写一句', w1.hidden === false && /写一句滚动的文字/.test(w1.txt), w1);

// 填 123
await js("(function(){var t=document.getElementById('ticker-text');t.value='123';t.dispatchEvent(new Event('input',{bubbles:true}));})()");
await sleep(200);
const w2 = await js("(function(){var w=document.getElementById('tickerWarn');return {hidden:w.hidden,txt:w.textContent,color:getComputedStyle(w).color};})()");
check('填「123」→ 提醒文案太短（3 个字）', w2.hidden === false && /文案太短（3 个字）/.test(w2.txt), w2);
check('提醒是红色（用 --bad 而不是普通正文色）', w2.color !== 'rgb(28, 34, 48)' && w2.color !== 'rgb(51, 41, 28)', w2.color);

// 填占位
await js("(function(){var t=document.getElementById('ticker-text');t.value='test test test';t.dispatchEvent(new Event('input',{bubbles:true}));})()");
await sleep(200);
const w3 = await js("(function(){var w=document.getElementById('tickerWarn');return {hidden:w.hidden,txt:w.textContent};})()");
check('填占位内容 → 提醒像占位', w3.hidden === false && /占位内容/.test(w3.txt), w3);

// 填一句真话
await js("(function(){var t=document.getElementById('ticker-text');t.value='本站数据每 3 小时自动更新一次';t.dispatchEvent(new Event('input',{bubbles:true}));})()");
await sleep(200);
const w4 = await js("(function(){var w=document.getElementById('tickerWarn');return {hidden:w.hidden,txt:w.textContent};})()");
check('写够 6 个字且不是占位 → 提醒消失', w4.hidden === true, w4);

// 关掉开关 → 提醒也不该留
await js("(function(){var e=document.getElementById('ticker-enabled');e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}));})()");
await sleep(200);
const w5 = await js("(function(){var w=document.getElementById('tickerWarn');return {hidden:w.hidden,txt:w.textContent};})()");
check('关掉开启 → 提醒隐藏（不留红字）', w5.hidden === true, w5);

if (W <= 430) {
  check('窄屏不横向溢出', await js('document.documentElement.scrollWidth === document.documentElement.clientWidth'), await js('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'ALL OK (' + pass + ')') + '  @' + W + 'px  ' + BASE);
ws.close(); proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);