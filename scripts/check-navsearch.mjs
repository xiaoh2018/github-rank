// 导航页搜索空态：真跑一遍「搜不到 → 清空搜索 → 恢复」，并验证「一个站点都没有」的空态指引
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const port = 9600 + Math.floor(Math.random() * 200);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(exe, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, n = 0; const pending = new Map();
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
      break;
    }
  } catch {}
  await sleep(200);
}
if (!ws) { console.log('no cdp target'); process.exit(2); }
const send = (m, p) => new Promise((res) => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('eval failed: ' + r.result.exceptionDetails.text);
  return r.result && r.result.result ? r.result.result.value : null;
};
let bad = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name + (extra ? '  → ' + extra : ''));
  else { bad++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
const stat = async () => JSON.parse(await ev(`(() => {
  const e = document.querySelector('.navempty');
  const s = document.getElementById('navSearch');
  return JSON.stringify({
    chips: document.querySelectorAll('.nj').length,
    empty: e ? e.textContent.replace(/\\s+/g, ' ').trim() : '',
    reset: !!document.querySelector('[data-navreset]'),
    val: s ? s.value : null
  });
})()`));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// A. 正常数据：搜不到 → 空态 + 清空入口 → 恢复
await send('Page.navigate', { url: BASE + '/?page=nav&t=' + Date.now() });
await sleep(2500);
const a0 = await stat();
ok('导航页有站点胶囊', a0.chips >= 1, 'chips=' + a0.chips);
ok('默认没有空态', a0.empty === '', JSON.stringify(a0.empty));

await ev("(function(){var i=document.getElementById('navSearch'); i.value='zzzznope'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()");
await sleep(600);
const a1 = await stat();
ok('搜不到时显示空态', a1.empty.length > 0, a1.empty.slice(0, 40));
ok('空态文案说清「换个关键词 / 清空搜索看全部」', /换个关键词/.test(a1.empty) && /清空搜索/.test(a1.empty), '');
ok('空态里给出清空按钮', a1.reset === true, '');
ok('搜不到时没有站点胶囊', a1.chips === 0, 'chips=' + a1.chips);

await ev("(document.querySelector('[data-navreset]')||{click:function(){}}).click()");
await sleep(600);
const a2 = await stat();
ok('点「清空搜索」后恢复站点', a2.chips >= 1, 'chips=' + a2.chips);
ok('点「清空搜索」后输入框被清空', a2.val === '', JSON.stringify(a2.val));
ok('恢复后空态消失', a2.empty === '', JSON.stringify(a2.empty));

// B. 一个站点都没有：显示「还没有站点」并指路后台
await send('Fetch.enable', { patterns: [{ urlPattern: '*/data/nav.json*' }, { urlPattern: '*/api/nav*' }] });
const FULL = JSON.stringify({ groups: [] });
const onPause = (params) => {
  send('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
    body: Buffer.from(FULL).toString('base64')
  });
};
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') onPause(m.params);
});
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: BASE + '/?page=nav&empty=1&t=' + Date.now() });
await sleep(2500);
const b0 = await stat();
ok('没有任何站点时显示「还没有站点」空态', /还没有站点/.test(b0.empty), b0.empty.slice(0, 40));
ok('空态指路后台「导航页」', /后台/.test(b0.empty) && /导航页/.test(b0.empty), '');
await send('Fetch.disable');

ws.close();
child.kill();
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（12 项）');
process.exit(bad ? 1 : 0);
