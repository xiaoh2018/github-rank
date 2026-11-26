// 门禁：首页「立即刷新」实时拉取的进度与取消
// - 拦下 api.github.com/search 的请求并「按住不放」，模拟慢网
// - 断言状态行报「已用 N 秒 / 已取到 M 个」并且有「取消这次刷新」
// - 点取消：状态行说已取消、榜单不动、按钮恢复、之后不再有新请求
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 390);
const H = Number(process.argv[3] || 844);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-rc-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  if (!page) await sleep(200);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
let held = 0;
const heldIds = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') {
    // 一律按住：既不给结果也不失败，模拟「GitHub 很慢」
    held++;
    heldIds.push(m.params.requestId);
  }
};
const send = (method, params = {}) => { const myId = ++id; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((r) => pending.set(myId, r)); };
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const v = r.result && r.result.result; return v ? v.value : undefined; };

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'OK   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 761 });
await send('Page.navigate', { url: BASE + '/?rc=' + Date.now() });
await sleep(2200);
// 塞一个假 Token：让 liveRefresh 走「用自己的 Token」这条路，不碰服务端
await ev(`localStorage.setItem('ghrank:token', 'ghp_testtoken0123456789012345678901234567')`);
await send('Fetch.enable', { patterns: [{ urlPattern: '*api.github.com/search*', requestStage: 'Request' }] });
await send('Page.navigate', { url: BASE + '/?rc2=' + Date.now() });
await sleep(2400);
check('页面先正常出榜单', (await ev(`document.querySelectorAll('#list .item').length`)) >= 10, 'cards=' + (await ev(`document.querySelectorAll('#list .item').length`)));

const readStatus = async () => JSON.parse(await ev(`(() => {
  const s = document.getElementById('status');
  const act = s.querySelector('.status-act');
  return JSON.stringify({
    txt: (s.innerText || '').trim(),
    hasAct: !!act,
    label: act ? act.textContent.trim() : '',
    sec: (String(s.innerText || '').match(/已用\\s*(\\d+)\\s*秒/) || [])[1] || '',
    got: (String(s.innerText || '').match(/已取到\\s*(\\d+)\\s*个/) || [])[1] || '',
    over: s.scrollWidth > s.clientWidth + 2,
    refreshDisabled: document.getElementById('btnRefresh').disabled,
    cards: document.querySelectorAll('#list .item').length,
  });
})()`));

await ev(`document.getElementById('btnRefresh').click()`);
await sleep(2000);
let st = await readStatus();
check('刷新中：状态行说在刷新', /实时刷新/.test(st.txt), st.txt.slice(0, 40));
check('刷新中：给出已用时', Number(st.sec) >= 1, 'sec=' + st.sec);
check('刷新中：给出已取到多少个', st.got !== '', 'got=' + st.got);
check('刷新中：有「取消这次刷新」', st.hasAct && /取消/.test(st.label), st.label);
check('刷新中：刷新按钮被禁用（防重复点）', st.refreshDisabled === true, 'disabled=' + st.refreshDisabled);
check('刷新中：状态行不溢出', !st.over, 'overflow=' + st.over);
const sec1 = Number(st.sec);

await sleep(1600);
st = await readStatus();
check('状态行的秒数在走（不是卡住的假进度）', Number(st.sec) > sec1, sec1 + ' -> ' + st.sec);

// 取消
const before = held;
await ev(`document.querySelector('#status .status-act').click()`);
await sleep(1500);
st = await readStatus();
check('取消后：状态行说已取消', /已取消/.test(st.txt), st.txt.slice(0, 40));
check('取消后：说明仍在看之前的数据', /仍(在看)?之前的数据/.test(st.txt), '');
check('取消后：取消按钮不再挂着', !st.hasAct || !/取消/.test(st.label), st.label);
check('取消后：刷新按钮恢复可点', st.refreshDisabled === false, 'disabled=' + st.refreshDisabled);
check('取消后：榜单没被清空', st.cards >= 10, 'cards=' + st.cards);
const stoppedAt = held;
await sleep(1800);
check('取消后：不再有新请求发出', held === stoppedAt, 'before=' + before + ' now=' + stoppedAt + ' after=' + held);

// 收尾：把按住的请求都放掉，别让页面挂着
for (const rid of heldIds) ws.send(JSON.stringify({ id: ++id, method: 'Fetch.failRequest', params: { requestId: rid, errorReason: 'Aborted' } }));
ws.close(); child.kill();
await sleep(300);
const bad = results.filter((r) => !r.pass).length;
console.log(bad === 0 ? '\nALL OK (' + results.length + ' 项，' + W + 'px)' : '\n' + bad + ' 项失败（共 ' + results.length + ' 项）');
process.exit(bad === 0 ? 0 : 1);
