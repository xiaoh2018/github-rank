// 门禁：导航页「显示全部」与「分组折叠」的状态要能跨刷新保留
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const pw = process.env.GHRANK_PW || 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
function pass(name, cond, extra) { if (cond) { ok++; console.log('  PASS  ' + name); } else { bad++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); } }

const api = async (p, body) => {
  const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};
const readNav = async () => { const r = await fetch(base + '/api/nav'); return (await r.json()).nav || { groups: [] }; };
const shape = (x) => JSON.stringify({ groups: (x && x.groups) || [] });

const original = await readNav();
const before = shape(original);
const seedName = '__门禁__持久化分组';

const port = 10200 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-navp-'));
const child = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });

let tg;
for (let i = 0; i < 60 && !tg; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); tg = l.find((x) => x.type === 'page'); } catch {}
  if (!tg) await sleep(250);
}
if (!tg) { console.log('Chrome 没起来'); process.exit(1); }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let n = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => { const i = ++n; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pend.set(i, r)); };
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description));
  return r.result && r.result.result && r.result.result.value;
}
const seedCards = () => evalJs(`(function(){var gs=[...document.querySelectorAll('#navBody .navgroup')];var g=gs.find(function(x){var t=(x.querySelector('.gtog')||{}).textContent||'';return t.indexOf('持久化分组')>=0;});return g?g.querySelectorAll('.navcard:not(.ad-inline-card)').length:-1;})()`);
const groupClosed = () => evalJs(`(function(){var g=document.querySelector('#navBody .navgroup');return g?g.classList.contains('is-closed'):null;})()`);
const reload = async () => { await send('Page.reload', { ignoreCache: false }); await sleep(2000); };

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });

  const items = Array.from({ length: 15 }, (_, i) => ({ name: '__持久化站点' + (i + 1), url: 'https://example.com/p' + (i + 1), desc: '门禁造数' }));
  const nav = JSON.parse(JSON.stringify(original));
  nav.groups = (nav.groups || []).concat([{ id: 'gateseedp', name: seedName, desc: '门禁造数分组', items }]);
  const w = await api('/api/nav', { password: pw, nav });
  pass('造数：新增 15 站分组', w.status === 200, 'status=' + w.status);

  await send('Page.navigate', { url: base + '/nav' });
  await sleep(2000);
  await evalJs("localStorage.removeItem('ghrank-nav-open'); localStorage.removeItem('ghrank-nav-closed')");
  await reload();

  pass('默认只渲染 12 个站点卡', (await seedCards()) === 12, 'n=' + (await seedCards()));

  // 展开「显示全部」
  await evalJs(`(function(){var gs=[...document.querySelectorAll('#navBody .navgroup')];var g=gs.find(function(x){var t=(x.querySelector('.gtog')||{}).textContent||'';return t.indexOf('持久化分组')>=0;});g.querySelector('.navmore').click();})()`);
  await sleep(800);
  pass('点「显示全部」后 15 个', (await seedCards()) === 15, 'n=' + (await seedCards()));
  const saved = await evalJs("localStorage.getItem('ghrank-nav-open')");
  pass('展开状态写进 localStorage', !!saved && saved.indexOf('gateseedp') >= 0, String(saved));

  await reload();
  pass('刷新后仍是 15 个（不再缩回 12）', (await seedCards()) === 15, 'n=' + (await seedCards()));

  // 折叠第一个分组
  await evalJs("document.querySelector('#navBody .navgroup .gtog').click()");
  await sleep(500);
  pass('点击后第一个分组收起', (await groupClosed()) === true, '');
  await reload();
  pass('刷新后第一个分组仍是收起', (await groupClosed()) === true, '');

  // 清掉本地状态 → 回到默认
  await evalJs("localStorage.removeItem('ghrank-nav-open'); localStorage.removeItem('ghrank-nav-closed')");
  await reload();
  pass('清掉本地状态后回到 12 个 + 展开', (await seedCards()) === 12 && (await groupClosed()) === false, 'cards=' + (await seedCards()) + ' closed=' + (await groupClosed()));
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  try {
    const after = shape(await readNav());
    if (after !== before) {
      const r = await api('/api/nav', { password: pw, nav: original });
      pass('导航数据已还原', shape(await readNav()) === before, 'status=' + r.status);
    } else {
      pass('导航数据已还原', true, 'no change');
    }
  } catch (e) { pass('导航数据已还原', false, String(e && e.message)); }
}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（' + ok + ' 项）');
process.exit(bad ? 1 : 0);
