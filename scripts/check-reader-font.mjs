import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const PORT = 9900 + Math.floor(Math.random() * 300);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
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
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => { pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, ms = 12000) {
  for (let t = 0; t < ms; t += 200) { try { if (await evalJs(expr)) return true; } catch (e) {} await sleep(200); }
  return false;
}
async function openFirstArticle() {
  await evalJs("document.querySelector('#cards .acard').click()");
  await waitFor("!!document.querySelector('#reader:not([hidden]) #rBody') && document.querySelector('#reader .abody').textContent.length > 0");
}

let bad = 0, total = 0;
function ok(name, cond, extra) { total++; if (cond) console.log('OK   ' + name); else { bad++; console.log('FAIL ' + name + (extra ? ' → ' + extra : '')); } }

(async () => {
  await connect();
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: BASE + '/articles' });
  ok('文章页渲染出卡片', await waitFor("document.querySelectorAll('#cards .acard').length > 0"));
  await openFirstArticle();

  ok('阅读器里出现字号工具条', await evalJs("!!document.querySelector('#reader #rTools') && !document.querySelector('#rTools').hidden"));
  const f0 = await evalJs("getComputedStyle(document.querySelector('#reader .abody')).fontSize");
  ok('默认正文字号 17px', f0 === '17px', f0);
  ok('工具条显示当前字号', (await evalJs("document.querySelector('#rfNow').textContent.trim()")) === '17');

  await evalJs("document.querySelector('#rfPlus').click(); document.querySelector('#rfPlus').click()");
  await sleep(120);
  const f1 = await evalJs("getComputedStyle(document.querySelector('#reader .abody')).fontSize");
  ok('点两次 A＋ 后是 20px', f1 === '20px', f1);
  ok('工具条数字跟着变', (await evalJs("document.querySelector('#rfNow').textContent.trim()")) === '20');
  ok('字号写进 localStorage', (await evalJs("localStorage.getItem('ghrank-reader-font')")) === '20');

  await send('Page.navigate', { url: BASE + '/articles' });
  await waitFor("document.querySelectorAll('#cards .acard').length > 0");
  await openFirstArticle();
  const f2 = await evalJs("getComputedStyle(document.querySelector('#reader .abody')).fontSize");
  ok('刷新后仍是 20px（记在本机）', f2 === '20px', f2);

  for (let i = 0; i < 6; i++) await evalJs("document.querySelector('#rfMinus').click()");
  await sleep(120);
  const f3 = await evalJs("getComputedStyle(document.querySelector('#reader .abody')).fontSize");
  ok('一路往下夹在最小 15px', f3 === '15px', f3);
  ok('到最小后 A− 变灰', (await evalJs("document.querySelector('#rfMinus').disabled")) === true);

  for (let i = 0; i < 8; i++) await evalJs("document.querySelector('#rfPlus').click()");
  await sleep(120);
  const f4 = await evalJs("getComputedStyle(document.querySelector('#reader .abody')).fontSize");
  ok('一路上夹在最大 22px', f4 === '22px', f4);
  ok('到最大后 A＋ 变灰', (await evalJs("document.querySelector('#rfPlus').disabled")) === true);

  const meta = await evalJs("document.querySelector('#rMeta').textContent");
  ok('阅读器不再出现「加密文章」这种措辞', !meta.includes('加密文章'), meta);
  ok('阅读器里没有「旧数据未加密」这类站务提示', !(await evalJs("document.querySelector('#reader').textContent")).includes('旧数据'));
  ok('阅读进度条存在', (await evalJs("!!document.getElementById('rprogress')")) === true);

  await evalJs("localStorage.removeItem('ghrank-reader-font')");
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/articles' });
  await waitFor("document.querySelectorAll('#cards .acard').length > 0");
  await openFirstArticle();
  const box = await evalJs("(function(){var t=document.querySelector('#rTools').getBoundingClientRect();return {right:t.right,left:t.left,w:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth};})()");
  ok('320 宽字号工具条不越界', box.right <= box.cw + 1 && box.left >= -1, JSON.stringify(box));
  ok('320 宽整页不横向溢出', box.w <= box.cw + 1, JSON.stringify(box));

  console.log(bad === 0 ? '\nALL OK (' + total + ')' : '\n' + bad + '/' + total + ' FAILED');
  ws.close(); chrome.kill();
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR ' + e.message); try { chrome.kill(); } catch (_) {} process.exit(1); });
