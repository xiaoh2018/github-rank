import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const PORT = 9600 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rs2-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; return; }
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('CDP 连不上');
}
function send(method, params = {}) { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); }); }
async function e(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 160)); return r.result && r.result.value; }
async function waitFor(expr, ms = 12000) { for (let t = 0; t < ms; t += 200) { try { if (await e(expr)) return true; } catch (err) {} await sleep(200); } return false; }

let bad = 0, total = 0;
function ok(name, cond, extra) { total++; if (cond) console.log('OK   ' + name); else { bad++; console.log('FAIL ' + name + (extra ? ' → ' + extra : '')); } }
const url = () => e('location.pathname');
const hidden = () => e("document.querySelector('#reader').hidden");

async function loadList(w = 390, h = 700) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  await send('Page.navigate', { url: BASE + '/articles' });
  await waitFor("document.querySelectorAll('#cards .acard').length > 0");
  await sleep(300);
}

(async () => {
  await connect(); await send('Page.enable'); await send('Runtime.enable');
  await loadList();
  const maxScroll = await e('document.documentElement.scrollHeight - window.innerHeight');
  await e('window.scrollTo(0, Math.min(420, ' + Math.max(0, maxScroll) + '))');
  await sleep(200);
  const y0 = await e('window.scrollY');
  ok('列表页能滚动（读测试前提）', y0 > 40, 'y0=' + y0);

  await e("document.querySelectorAll('#cards .acard')[0].click()");
  await waitFor("!document.querySelector('#reader').hidden");
  await sleep(300);
  ok('点开文章后地址变成文章页', (await url()).indexOf('/articles/') === 0, await url());
  ok('点开文章后回到正文顶部', (await e('window.scrollY')) <= 2, String(await e('window.scrollY')));

  await e("document.querySelector('#rback').click()");
  await sleep(500);
  ok('点「返回文章列表」后阅读器收起', (await hidden()) === true);
  ok('返回后地址回到 /articles', (await url()) === '/articles', await url());
  const y1 = await e('window.scrollY');
  ok('返回后滚动位置被还原', Math.abs(y1 - y0) <= 8, 'y0=' + y0 + ' y1=' + y1);

  await e("document.querySelectorAll('#cards .acard')[0].click()");
  await waitFor("!document.querySelector('#reader').hidden");
  await sleep(250);
  await e('history.back()');
  await sleep(500);
  ok('浏览器后退也能收起阅读器', (await hidden()) === true);
  ok('后退后地址是 /articles', (await url()) === '/articles', await url());

  // 深链：直接打开文章地址
  await send('Page.navigate', { url: BASE + '/articles/tech/4.html' });
  await waitFor("!document.querySelector('#reader').hidden && document.querySelector('#rTitle').textContent.length > 0");
  ok('深链直接进阅读器', (await hidden()) === false);
  ok('深链标题正确', (await e("document.querySelector('#rTitle').textContent")).indexOf('目录高亮') >= 0, await e("document.querySelector('#rTitle').textContent"));
  const hist0 = await e('history.length');
  await e("document.querySelector('#rback').click()");
  await sleep(500);
  ok('深链点返回后收起', (await hidden()) === true);
  ok('深链点返回后地址是 /articles', (await url()) === '/articles', await url());
  ok('深链返回不会多塞历史记录', (await e('history.length')) <= hist0, hist0 + ' → ' + (await e('history.length')));

  // 刷新仍保持在文章
  await e("document.querySelectorAll('#cards .acard')[0].click()");
  await waitFor("!document.querySelector('#reader').hidden");
  const tBefore = await e("document.querySelector('#rTitle').textContent");
  await send('Page.reload');
  await waitFor("document.querySelectorAll('#cards .acard').length > 0");
  await sleep(700);
  ok('刷新后仍在阅读器里', (await hidden()) === false);
  const tAfter = await e("document.querySelector('#rTitle').textContent");
  ok('刷新后仍是同一篇', tAfter === tBefore, tBefore + ' → ' + tAfter);

  console.log(bad === 0 ? '\nALL OK (' + total + ')' : '\n' + bad + '/' + total + ' FAILED');
  ws.close(); chrome.kill();
  process.exit(bad === 0 ? 0 : 1);
})().catch((err) => { console.error('ERROR ' + err.message); try { chrome.kill(); } catch (_) {} process.exit(1); });
