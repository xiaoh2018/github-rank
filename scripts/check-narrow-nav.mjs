// 门禁：后台侧栏在窄屏变横向胶囊条后，分组小标题不该夹在标签之间
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
  const port = 9950 + Math.floor(Math.random() * 40);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-nnav-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' });
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
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
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

const probe = `(function(){
  var groups = Array.prototype.slice.call(document.querySelectorAll('.side .navgroup'));
  var vis = groups.filter(function(g){ return getComputedStyle(g).display !== 'none'; });
  var side = document.querySelector('.side');
  var tabs = document.querySelectorAll('.side .nav');
  var cs = side ? getComputedStyle(side) : null;
  return {
    groups: groups.length,
    visGroups: vis.length,
    visTexts: vis.map(function(g){ return g.textContent.trim(); }).slice(0, 4),
    tabs: tabs.length,
    sideH: side ? Math.round(side.getBoundingClientRect().height) : -1,
    navH: tabs.length ? Math.round(tabs[0].getBoundingClientRect().height) : -1,
    paneMissing: Array.prototype.filter.call(tabs, function(t){ return !document.getElementById('pane-' + t.getAttribute('data-tab')); }).map(function(t){ return t.getAttribute('data-tab'); }),
    sideOverflow: side ? side.scrollWidth - side.clientWidth : -1,
    sideOverflowX: cs ? cs.overflowX : '',
    sideSnap: cs ? cs.scrollSnapType : ''
  };
})()`;

// 手机 320
{
  const s = await open(320, 720);
  try {
    const r = await s.evalJs(probe);
    push('320：侧栏分组小标题全部隐藏', r && r.groups > 0 && r.visGroups === 0, r ? r.groups + '/' + r.visGroups : '');
    push('320：每个标签都对应一个面板（无孤儿）', r && r.tabs >= 12 && r.paneMissing.length === 0, r ? r.tabs + ' 个标签' : '');
    push('320：侧栏可横滚（overflow-x auto）', r && r.sideOverflowX === 'auto', r && r.sideOverflowX);
    push('320：侧栏只占一行（高度 ≤64）', r && r.sideH > 0 && r.sideH <= 64, r && r.sideH);
    push('320：标签高度 40–52（触控友好又不吃屏）', r && r.navH >= 40 && r.navH <= 52, r && r.navH);
    const jumped = await s.evalJs(`(function(){
      var last = document.querySelectorAll('.side .nav');
      var t = last[last.length - 1];
      t.click();
      var pane = document.getElementById('pane-' + t.getAttribute('data-tab'));
      var rect = t.getBoundingClientRect();
      var sideR = document.querySelector('.side').getBoundingClientRect();
      return {
        paneVisible: pane ? !pane.hidden : false,
        cur: t.getAttribute('aria-current'),
        inView: rect.left >= sideR.left - 1 && rect.right <= sideR.right + 1
      };
    })()`);
    await sleep(400);
    push('320：点最后一个标签能切换面板', jumped && jumped.paneVisible, jumped && jumped.paneVisible);
    push('320：当前标签 aria-current=true', jumped && jumped.cur === 'true', jumped && jumped.cur);
  } finally { s.ws.close(); s.child.kill(); }
}

// 桌面 1440
{
  const s = await open(1440, 900);
  try {
    const r = await s.evalJs(probe);
    push('1440：分组小标题可见', r && r.visGroups >= 3, r ? r.visGroups : '');
    push('1440：分组标题有文字（常用 / 内容 …）', r && r.visTexts.length >= 3 && r.visTexts.every(function (t) { return t.length > 0; }), r && r.visTexts.join('|'));
    push('1440：每个标签都对应一个面板（无孤儿）', r && r.tabs >= 12 && r.paneMissing.length === 0, r ? r.tabs + ' 个标签' : '');
  } finally { s.ws.close(); s.child.kill(); }
}

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? '全部通过（' + rows.length + ' 项）' : bad + ' 项失败 / ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
