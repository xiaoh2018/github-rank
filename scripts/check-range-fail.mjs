// 门禁：切换榜单范围（近 7 天 → 总榜）时，数据文件读不到要有交代
// A 两个文件都读不到 → 错误卡（人话 + 重试 + 稍后再看），骨架必须收掉，不能一直转
// B 只有主文件读不到 → 退到备用文件并明确告知「可能不是最新的」
// C 正常 → 有卡片、状态行干净
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const WIDE = process.env.PROBE_W === '1440';
const W = WIDE ? 1440 : 390;
const H = WIDE ? 900 : 844;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9800 + Math.floor(Math.random() * 120);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-rf-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

let page;
for (let i = 0; i < 80 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  if (!page) await sleep(150);
}
if (!page) { console.error('no cdp target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map(); let paused = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') {
    paused++;
    ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.failRequest', params: { requestId: m.params.requestId, errorReason: 'ConnectionFailed' } }));
  }
};
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const v = r.result && r.result.result; return v ? v.value : undefined; };

await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: !WIDE });

const SNAP = `(() => {
  const list = document.getElementById('list');
  const st = document.getElementById('status');
  const err = list.querySelector('.err-card');
  return JSON.stringify({
    cards: list.querySelectorAll('.item').length,
    skel: list.querySelectorAll('.skel').length,
    err: err ? 1 : 0,
    errText: err ? (err.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '',
    errActs: err ? [...err.querySelectorAll('button,a')].map(b => (b.innerText || '').trim()).join('|') : '',
    status: (st.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    busy: list.getAttribute('aria-busy'),
    over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  });
})()`;

async function openRange(pattern) {
  await ev('(async () => { if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); for (const r of rs) await r.unregister(); } })()').catch(() => {});
  await send('Page.navigate', { url: BASE + '/?rf=' + Date.now() + Math.random() });
  await sleep(2200);
  if (pattern) { paused = 0; await send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] }); }
  await ev(`(function(){ const b=[...document.querySelectorAll('[data-range]')].find(x=>x.dataset.range==='total'); b && b.click(); return 1; })()`);
  let last = null;
  for (let t = 0; t < 20; t++) {
    const s = JSON.parse(await ev(SNAP));
    last = s;
    if (s.err || s.cards > 0) break;
    await sleep(400);
  }
  if (pattern) await send('Fetch.disable');
  return last;
}

const checks = [];
const ok = (name, cond, extra = '') => { checks.push({ name, cond: !!cond, extra }); console.log((cond ? 'OK   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

// C 正常路径
const good = await openRange(null);
ok('正常切到总榜有卡片', good.cards >= 10, 'cards=' + good.cards);
ok('正常路径状态行不报错', good.status === '', 'status=' + good.status);
ok('正常路径骨架收掉', good.skel === 0, 'skel=' + good.skel);

// B 只拦主文件 → 备用文件
const fb = await openRange('*repos-total.js*');
ok('主文件读不到时仍出卡片（用备用文件）', fb.cards >= 10, 'cards=' + fb.cards + ' paused=' + paused);
ok('备用文件要被说出来', /备用数据文件/.test(fb.status) && /可能不是最新的/.test(fb.status), 'status=' + fb.status);
ok('备用路径不出错误卡', fb.err === 0, 'err=' + fb.err);

// A 两个都拦 → 错误卡
const dead = await openRange('*repos-*');
ok('两个文件都读不到时出错误卡', dead.err === 1, 'err=' + dead.err);
ok('错误卡说的是榜单数据文件', /这个榜单的数据文件没读出来/.test(dead.errText), dead.errText);
ok('错误卡给了退路（切回近 7 天）', /近 7 天/.test(dead.errText), dead.errText);
ok('错误卡有重试与稍后再看', /重试/.test(dead.errActs) && /稍后/.test(dead.errActs), dead.errActs);
ok('骨架必须收掉（不能一直转）', dead.skel === 0, 'skel=' + dead.skel);
ok('aria-busy 要撤掉', dead.busy === null, 'busy=' + dead.busy);
ok('状态行不再挂着「加载数据…」', !/加载数据/.test(dead.status), 'status=' + dead.status);
ok(W + 'px 不溢出', !dead.over, 'over=' + dead.over);

ws.close(); child.kill();
await sleep(150);
const bad = checks.filter((c) => !c.cond);
console.log(bad.length ? '\n' + bad.length + ' FAILED' : '\nALL OK (' + checks.length + ')');
process.exit(bad.length ? 1 : 0);
