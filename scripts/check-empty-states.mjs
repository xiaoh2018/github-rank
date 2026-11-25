// 门禁：/nav 与 /faq 的加载骨架 + 空态卡片（v142）
// 1) 源码里真的有骨架与空态样式
// 2) 页面加载后 aria-busy 被移除（骨架消失）
// 3) /nav 搜乱码 → 空态卡 + 「清空搜索」按钮，点它恢复列表
// 4) /faq 搜乱码 → 空态卡 + 「清空搜索与标签」，点它恢复列表
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('OK   ' + m); };
const bad = (m) => { fail++; console.log('FAIL ' + m); };

const home = await (await fetch(BASE + '/', { cache: 'no-store' })).text();
const faq = await (await fetch(BASE + '/faq', { cache: 'no-store' })).text();
(home.includes('class="navskel"') ? ok : bad)('首页源码有导航骨架 .navskel');
(home.includes('@keyframes ghsk') ? ok : bad)('首页源码有骨架动画 ghsk');
(home.includes('class="navempty"') ? ok : bad)('首页源码有空态卡 .navempty');
(home.includes('data-navreset="1"') ? ok : bad)('首页源码有「清空搜索」按钮');
(home.includes('aria-busy="true"') ? ok : bad)('首页 #navBody 初始 aria-busy');
(faq.includes('.skrow') ? ok : bad)('问答页源码有骨架 .skrow');
(faq.includes('renderSkeleton') ? ok : bad)('问答页源码有 renderSkeleton()');
(faq.includes('data-reset="1"') ? ok : bad)('问答页源码有重置按钮');

// ---- CDP ----
const port = 9600 + Math.floor(Math.random() * 300);
const prof = path.join(os.tmpdir(), 'cr-empty-' + Date.now());
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1440,1000',
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

let ws = null, id = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id); pending.delete(m.id);
            m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
          }
        };
        return;
      }
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('Chrome 没起来');
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.result));
  return r.result.value;
}
async function goto(url, wait = 1400) {
  await send('Page.navigate', { url });
  await sleep(wait);
}

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // /nav
  await goto(BASE + '/?page=nav', 2200);
  const navBusy = await evalJs("(document.getElementById('navBody')||{}).getAttribute ? document.getElementById('navBody').getAttribute('aria-busy') : 'x'");
  (navBusy === null ? ok : bad)('导航加载完 aria-busy 已移除（实际 ' + navBusy + '）');
  const navCards = await evalJs("document.querySelectorAll('#navBody .navcard:not(.ad-inline-card)').length");
  (navCards > 0 ? ok : bad)('导航渲染出 ' + navCards + ' 个站点卡');
  await evalJs("(function(){var i=document.getElementById('navSearch'); i.value='zzqq不存在的站点'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()");
  await sleep(500);
  const navEmpty = await evalJs("(function(){var e=document.querySelector('#navBody .navempty'); return e?e.textContent.replace(/\\s+/g,' ').trim():''})()");
  (navEmpty.indexOf('没有匹配的站点') >= 0 ? ok : bad)('导航空态文案（' + navEmpty.slice(0, 24) + '…）');
  (navEmpty.indexOf('清空搜索') >= 0 ? ok : bad)('导航空态带「清空搜索」按钮');
  await evalJs("document.querySelector('#navBody [data-navreset]').click(); 1");
  await sleep(600);
  const navBack = await evalJs("document.querySelectorAll('#navBody .navcard:not(.ad-inline-card)').length");
  (navBack > 0 ? ok : bad)('点「清空搜索」后恢复 ' + navBack + ' 个站点卡');
  const navQ = await evalJs("(document.getElementById('navSearch')||{}).value");
  (navQ === '' ? ok : bad)('搜索框已清空（实际 "' + navQ + '"）');

  // /faq
  await goto(BASE + '/faq', 2000);
  const faqBusy = await evalJs("document.getElementById('list').getAttribute('aria-busy')");
  (faqBusy === null ? ok : bad)('问答加载完 aria-busy 已移除（实际 ' + faqBusy + '）');
  const faqCount = await evalJs("document.querySelectorAll('#list .qa').length");
  (faqCount > 0 ? ok : bad)('问答渲染出 ' + faqCount + ' 条');
  await evalJs("(function(){var i=document.getElementById('q'); i.value='zzqq不存在的问题'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()");
  await sleep(600);
  const faqEmpty = await evalJs("(function(){var e=document.querySelector('#list .empty'); return e?e.textContent.replace(/\\s+/g,' ').trim():''})()");
  (faqEmpty.indexOf('没有匹配的问题') >= 0 ? ok : bad)('问答空态文案（' + faqEmpty.slice(0, 24) + '…）');
  (faqEmpty.indexOf('清空搜索与标签') >= 0 ? ok : bad)('问答空态带「清空搜索与标签」');
  await evalJs("document.querySelector('#list [data-reset]').click(); 1");
  await sleep(700);
  const faqBack = await evalJs("document.querySelectorAll('#list .qa').length");
  (faqBack > 0 ? ok : bad)('点重置后恢复 ' + faqBack + ' 条问答');
  const faqQ = await evalJs("(document.getElementById('q')||{}).value");
  (faqQ === '' ? ok : bad)('问答搜索框已清空（实际 "' + faqQ + '"）');
  const faqHash = await evalJs('location.search');
  (faqHash.indexOf('q=') < 0 ? ok : bad)('URL 里的 q 参数已去掉（' + faqHash + '）');
} catch (e) {
  bad('执行异常: ' + e.message);
} finally {
  try { await send('Browser.close'); } catch (e) {}
  try { child.kill(); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL ' + pass + ' OK'));
  process.exit(fail ? 1 : 0);
}
