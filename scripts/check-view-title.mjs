// 门禁：站内切视图（榜单/导航/文章/问答）时 <title> 与读屏播报跟着走
// 用法：node scripts/check-view-title.mjs           （本地 dev-server 8123）
//       PROBE_BASE=https://github.661026.xyz node scripts/check-view-title.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/$/, '');
const PORT = 9500 + Math.floor(Math.random() * 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };
const waitFor = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(150); } return false; };

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('OK   ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); } else { fail++; console.log('FAIL ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); } };

for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; break; }
  } catch {}
  await sleep(200);
}
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// 1) 首页初始标题 = 服务器给的那一条（不能是硬编码）
await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
await waitFor("document.querySelectorAll('#list .item').length > 3", 25000);
await sleep(600);
const baseTitle = String((await js('document.title')) || '');
check('初始标题是站点标题', /GitHub 热门项目排行榜/.test(baseTitle), baseTitle.slice(0, 40));

// 2) 四个视图逐个切，标题必须跟着变
const cases = [['tabNav', '站点导航', '导航'], ['tabArticles', '文章', '文章'], ['tabFaq', '问答', '问答']];
const seen = {};
for (const [tid, want, live] of cases) {
  await js('document.getElementById(' + JSON.stringify(tid) + ').click()');
  await sleep(700);
  const t = String((await js('document.title')) || '');
  seen[tid] = t;
  check(live + '视图的标题含有「' + want + '」且不再是榜单标题', t.includes(want) && t !== baseTitle, t.slice(0, 40));
  const lv = String((await js("document.getElementById('viewLive').textContent")) || '');
  check(live + '视图会播报「已切换到' + live + '」', lv === '已切换到' + live, lv);
}

// 3) 回到榜单：标题必须逐字回到服务器那条（SEO 标题不能被写死覆盖）
await js("document.getElementById('tabRank').click()");
await sleep(700);
const back = String((await js('document.title')) || '');
check('回到榜单后标题逐字还原', back === baseTitle, { back: back.slice(0, 40), base: baseTitle.slice(0, 40) });
check('回到榜单后播报「已切换到榜单」', String((await js("document.getElementById('viewLive').textContent")) || '') === '已切换到榜单');

// 4) 播报区必须是 aria-live 且视觉隐藏（否则屏幕上会多一行字）
const liveAttr = await js("(function(){var p=document.getElementById('viewLive');if(!p)return null;var r=p.getBoundingClientRect();return {live:p.getAttribute('aria-live'),w:Math.round(r.width),h:Math.round(r.height),pos:getComputedStyle(p).position};})()");
check('播报区是 aria-live=polite', !!liveAttr && liveAttr.live === 'polite', liveAttr);
check('播报区视觉隐藏（≤1px）', !!liveAttr && liveAttr.w <= 1 && liveAttr.h <= 1, liveAttr && { w: liveAttr.w, h: liveAttr.h });

// 5) 深链：直接打开 /?page=faq 时标题就是问答（首屏不等点击）
await send('Page.navigate', { url: BASE + '/?page=faq&t=' + Date.now() });
await waitFor("document.getElementById('tabFaq') && getComputedStyle(document.getElementById('faqView')).display !== 'none'", 25000);
await sleep(700);
const deepFaq = String((await js('document.title')) || '');
check('深链 /?page=faq 首屏标题就是问答', deepFaq.includes('问答') && deepFaq !== baseTitle, deepFaq.slice(0, 40));

// 6) 深链文章：/?page=articles
await send('Page.navigate', { url: BASE + '/?page=articles&t=' + Date.now() });
await waitFor("document.getElementById('tabArticles') && getComputedStyle(document.getElementById('artView')).display !== 'none'", 25000);
await sleep(700);
const deepArt = String((await js('document.title')) || '');
check('深链 /?page=articles 首屏标题就是文章', deepArt.includes('文章') && deepArt !== baseTitle, deepArt.slice(0, 40));

// 7) 390 下也不该溢出（标题改动不该影响布局）
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
await waitFor("document.querySelectorAll('#list .item').length > 3", 25000);
await sleep(500);
check('390 不横向溢出', await js('document.documentElement.scrollWidth === document.documentElement.clientWidth'), await js('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'));

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'ALL OK (' + pass + ')') + '  @' + BASE);
ws.close(); proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);