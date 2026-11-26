// 门禁：后台卡片保存按钮在手机上吸底 + 撑满，桌面上保持原样
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function open(width, height) {
  const port = 9700 + Math.floor(Math.random() * 60);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-stk-'));
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + udd, 'about:blank',
  ], { stdio: 'ignore' });
  const wsUrl = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        const page = list.find((t) => t.type === 'page');
        if (page) return page.webSocketDebuggerUrl;
      } catch {}
      await sleep(250);
    }
    throw new Error('chrome not ready');
  })();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waits = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    waits.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 760 });
  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1800);
  await evalJs("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit();");
  await sleep(1500);
  return { ws, child, evalJs };
}

const probe = (tab) => `(function(){
  document.querySelector('.nav[data-tab="${tab}"]').click();
  var pane = document.querySelector('#pane-${tab}');
  var act = pane.querySelector('.card .actions');
  if (!act) return { missing: true };
  act.scrollIntoView({ block: 'end' });
  var cs = getComputedStyle(act);
  var ar = act.getBoundingClientRect();
  var pr = pane.getBoundingClientRect();
  var b = act.querySelector('button');
  var br = b ? b.getBoundingClientRect() : null;
  var fab = document.getElementById('cmdkFab');
  var fr = fab && getComputedStyle(fab).display !== 'none' ? fab.getBoundingClientRect() : null;
  var overlap = false;
  if (fr && br) overlap = !(fr.right <= br.left || fr.left >= br.right || fr.bottom <= br.top || fr.top >= br.bottom);
  return {
    pos: cs.position, bottom: cs.bottom,
    actW: Math.round(ar.width), paneW: Math.round(pr.width),
    btnW: br ? Math.round(br.width) : 0, btnH: br ? Math.round(br.height) : 0,
    fabBottomGap: fr ? Math.round(window.innerHeight - fr.bottom) : null,
    overlap: overlap
  };
})()`;

// 手机
{
  const { ws, child, evalJs } = await open(390, 844);
  try {
    for (const tab of ['contact', 'beian']) {
      const r = await evalJs(probe(tab));
      await sleep(400);
      push('手机：' + tab + ' 保存按钮吸底', r && r.pos === 'sticky', r && r.pos);
      push('手机：' + tab + ' 保存按钮占满剩余宽度（≥ 卡片宽 - 90）', r && r.btnW >= r.actW - 90, r ? r.btnW + '/' + r.actW : '');
      push('手机：' + tab + ' 保存按钮高度 ≥ 44', r && r.btnH >= 44, r && r.btnH);
      push('手机：' + tab + ' 命令面板按钮不与保存条按钮重叠', r && r.overlap === false, r && r.overlap);
      push('手机：命令面板按钮落在保存条这一行里（离底 ≤ 40）', r && r.fabBottomGap <= 40, r && r.fabBottomGap);
    }
  } finally { ws.close(); child.kill(); }
}

// 桌面
{
  const { ws, child, evalJs } = await open(1440, 900);
  try {
    const r = await evalJs(probe('contact'));
    push('桌面：保存按钮不吸底（position static）', r && r.pos === 'static', r && r.pos);
    push('桌面：保存按钮不撑满（< 卡片宽 80%）', r && r.btnW < r.actW * 0.8, r ? r.btnW + '/' + r.actW : '');
  } finally { ws.close(); child.kill(); }
}

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? '全部通过（' + rows.length + ' 项）' : bad + ' 项失败 / ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
