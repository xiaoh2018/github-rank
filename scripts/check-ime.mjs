import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const PORT = 10120 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();
let fails = 0, total = 0;

async function connect() { for (let i = 0; i < 80; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; return; } } catch (e) {} await sleep(200); } throw new Error('CDP 连不上'); }
function send(method, params = {}) { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); }); }
async function e(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 120); return r.result && r.result.value; }
async function waitFor(expr, ms = 15000) { for (let t = 0; t < ms; t += 150) { try { if (await e(expr)) return true; } catch (err) {} await sleep(150); } return false; }
function ok(name, cond, extra = '') { total++; if (cond) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + '  ' + extra); } }

const SIM = (sel, mid, fin) => `(function(){
  var el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'no-el';
  el.focus();
  el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
  el.value = ${JSON.stringify(mid)};
  el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:${JSON.stringify(mid)},inputType:'insertCompositionText'}));
  return 'composing';
})()`;

const FIN = (sel, fin) => `(function(){
  var el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'no-el';
  el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:${JSON.stringify(fin)}}));
  el.value = ${JSON.stringify(fin)};
  el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false,data:${JSON.stringify(fin)},inputType:'insertText'}));
  return 'done';
})()`;

const COUNT = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).length`;

async function nav(url, waitExpr) {
  await send('Page.navigate', { url: BASE + url });
  if (waitExpr) await waitFor(waitExpr);
  await sleep(500);
}

async function caseIme(label, url, waitExpr, inputSel, countSel, midText, finText) {
  if (url) await nav(url, waitExpr);
  const base = await e(COUNT(countSel));
  if (!(base > 0)) { ok(label + '：列表有内容', false, 'base=' + base); return; }
  const a = await e(SIM(inputSel, midText, finText));
  await sleep(400);
  const during = await e(COUNT(countSel));
  ok(label + '：拼音未上屏时不过滤', during === base, JSON.stringify({ base, during, sim: a }));
  await e(FIN(inputSel, finText));
  await sleep(450);
  const after = await e(COUNT(countSel));
  ok(label + '：上屏后过滤生效', after < base, JSON.stringify({ base, after }));
}

(async () => {
  await connect(); await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // 1) 首页榜单搜索
  await caseIme('首页搜索', '/', "document.querySelectorAll('#list .item').length>0", '#q', '#list .item:not(.ad-inline)', 'zzzz', 'wasm');

  // 2) SPA 文章视图搜索
  await caseIme('文章视图搜索', '/?page=articles', "document.querySelectorAll('#artViewList .artcard').length>0", '#artSearch', '#artViewList .artcard', 'zzzz', '目录');

  // 3) SPA 问答视图搜索
  await caseIme('问答视图搜索', '/?page=faq', "document.querySelectorAll('#faqList .qa').length>0", '#faqSearch', '#faqList .qa', 'zzzz', '更新');

  // 4) /articles 静态页搜索
  await caseIme('/articles 搜索', '/articles', "document.querySelectorAll('#cards .acard').length>0", '#search', '#cards .acard', 'zzzz', '目录');

  // 5) /faq 静态页搜索
  await caseIme('/faq 搜索', '/faq', "document.querySelectorAll('.qa').length>0", '#q', '.qa', 'zzzz', '更新');

  // 6) 后台：问答筛选
  await nav('/admin', "!!document.getElementById('pw')");
  await e("(function(){document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); return 'ok';})()");
  const logged = await waitFor("document.getElementById('app') && document.getElementById('app').hidden === false", 12000);
  if (!logged) {
    ok('后台登录', false, await e("(document.getElementById('gateMsg')||{}).textContent||''"));
  } else {
    await e("document.querySelector('.nav[data-tab=\"qa\"]').click()");
    await waitFor("document.querySelectorAll('#qaList .qa-row').length>0");
    await sleep(400);
    await caseIme('后台问答筛选', null, null, '#qaFilter', '#qaList .qa-row', 'zzzz', 'cron');
  }

  console.log('\n' + (fails ? 'FAILED ' + fails + ' / ' + total : 'ALL OK (' + total + ')'));
  try { ws.close(); } catch (err) {}
  chrome.kill();
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error('ERROR ' + err.message); try { chrome.kill(); } catch (e2) {} process.exit(1); });
