import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 900);
const rows = [];
const push = (n, ok, extra) => rows.push({ n, ok: !!ok, extra: extra || '' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!chrome) throw new Error('找不到 Chrome');

const dataFile = path.resolve('data/site.json');
const backup = fs.readFileSync(dataFile, 'utf8');

const port = 9300 + Math.floor(Math.random() * 400);
const dir = path.join(os.tmpdir(), 'cdp-save-' + Date.now());
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=' + port, '--user-data-dir=' + dir, 'about:blank',
], { stdio: 'ignore' });

let ws;
const pending = new Map();
let seq = 0;
let failSite = false;

function send(method, params) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS 异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function waitFor(expr, ms = 15000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return true;
    await sleep(step);
  }
  return false;
}

try {
  await sleep(900);
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      return;
    }
    if (m.method === 'Fetch.requestPaused') {
      const rid = m.params.requestId;
      const url = m.params.request.url || '';
      if (failSite && url.includes('/api/site')) send('Fetch.failRequest', { requestId: rid, errorReason: 'ConnectionRefused' });
      else send('Fetch.continueRequest', { requestId: rid });
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 800 });

  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1800);
  await evaluate("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); true");
  await sleep(2200);
  push('登录成功', await evaluate("document.getElementById('app').hidden===false"));

  // 进「联系方式」
  await evaluate("document.querySelector('.nav[data-tab=\"contact\"]').click(); true");
  await sleep(600);
  push('联系方式面板可见', await evaluate("document.getElementById('pane-contact').offsetHeight>0"));

  // 打挂保存请求
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/site*', requestStage: 'Request' }] });
  failSite = true;
  await evaluate("document.querySelector('[data-save=\"contact\"]').click(); true");
  push('保存中按钮文案会变', await waitFor("document.querySelector('[data-save=\"contact\"]').textContent.indexOf('保存中')>=0", 4000));
  const failed = await waitFor("!!document.querySelector('#pane-contact .save-msg.err')", 15000);
  push('失败时出现红色状态行', failed);
  const errText = await evaluate("(document.querySelector('#pane-contact .save-msg.err')||{}).textContent||''");
  push('失败原因写人话', errText.indexOf('保存失败：') === 0 && errText.indexOf('网络') >= 0, errText);
  push('失败状态行带「重试」', await evaluate("!!(document.querySelector('#pane-contact .save-msg.err .linkbtn')||{}).textContent"));
  push('失败后按钮恢复可点', await evaluate("(function(){var b=document.querySelector('[data-save=\"contact\"]');return b.disabled===false && b.textContent.indexOf('保存')===0;})()"));

  // 放开拦截，点重试
  failSite = false;
  await send('Fetch.disable');
  await evaluate("document.querySelector('#pane-contact .save-msg.err .linkbtn').click(); true");
  const okd = await waitFor("!!document.querySelector('#pane-contact .save-msg.ok')", 15000);
  push('重试后变成「已保存」', okd);
  const okText = await evaluate("(document.querySelector('#pane-contact .save-msg.ok')||{}).textContent||''");
  push('已保存带时间戳', okText.indexOf('已保存') === 0 && /\d{1,2}:\d{2}/.test(okText), okText);

  // 常驻性：等 3.5 秒后还在（toast 2.6 秒就消失）
  await sleep(3500);
  push('状态行不会 3 秒后消失', await evaluate("!!document.querySelector('#pane-contact .save-msg.ok')"));

  // 通用性：广告面板自己的状态行
  await evaluate("document.querySelector('.nav[data-tab=\"ad\"]').click(); true");
  await sleep(500);
  await evaluate("document.querySelector('#pane-ad [data-save=\"ad\"]').click(); true");
  const adOk = await waitFor("!!document.querySelector('#pane-ad .save-msg.ok')", 15000);
  push('其它面板同样有独立状态行', adOk);
  push('两个面板的状态行互不串台', await evaluate("document.querySelectorAll('#pane-contact .save-msg').length===1 && document.querySelectorAll('#pane-ad .save-msg').length===1"));

  // 窄屏：状态行独占一行不溢出
  if (W < 800) {
    const box = await evaluate("(function(){var m=document.querySelector('#pane-ad .save-msg');var a=m.parentNode;var cs=getComputedStyle(a);var inner=a.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);return {w:Math.round(m.getBoundingClientRect().width),inner:Math.round(inner),sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth};})()");
    push('窄屏状态行独占一行', box.w >= box.inner - 4, JSON.stringify(box));
    push('窄屏不横向溢出', box.sw <= box.cw + 1, box.sw + '/' + box.cw);
  }
} finally {
  try { fs.writeFileSync(dataFile, backup, 'utf8'); } catch {}
  try { await send('Browser.close'); } catch {}
  try { ws && ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
