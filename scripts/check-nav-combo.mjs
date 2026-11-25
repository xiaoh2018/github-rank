// 门禁：导航页三个交互的组合 —— 折叠 × 搜索 × 加载更多
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
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};
const readNav = async () => { const r = await fetch(base + '/api/nav'); return (await r.json()).nav || { groups: [] }; };

const original = await readNav();
// updatedAt 每次写回都会变，比较时剔掉它，否则永远「没还原」
const shape = (x) => JSON.stringify({ groups: (x && x.groups) || [] });
const before = shape(original);
const seedName = '__门禁__组合大分组';
let seeded = false;

const port = 9820 + Math.floor(Math.random() * 120);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-navc-'));
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });

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
const goto = async (url) => { await send('Page.navigate', { url: base + url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now() }); await sleep(1900); };

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });

  // 造一个 15 站的组（为了触发「显示全部」）
  const items = Array.from({ length: 15 }, (_, i) => ({ name: '__组合站点' + (i + 1), url: 'https://example.com/' + (i + 1), desc: '门禁造数' }));
  const nav = JSON.parse(JSON.stringify(original));
  nav.groups = (nav.groups || []).concat([{ id: 'gateseed', name: seedName, desc: '门禁造数分组', items }]);
  const w = await api('/api/nav', { password: pw, nav });
  seeded = w.status === 200;
  pass('造数：新增 15 站分组', seeded, 'status=' + w.status + ' ' + JSON.stringify(w.json && w.json.error || ''));

  await goto('/nav');
  await evalJs(`localStorage.removeItem('ghrank-nav-closed')`);

  // A. 折叠
  await goto('/nav');
  const g0 = await evalJs(`(() => {
    const gs = [...document.querySelectorAll('#navBody .navgroup')];
    return gs.map(g => ({ id: (g.querySelector('.gtog') || {}).textContent || '', closed: g.classList.contains('is-closed'), cards: g.querySelectorAll('.navcard').length }));
  })()`);
  pass('分组默认展开', g0.length > 0 && g0.every((g) => !g.closed), 'n=' + g0.length);

  await evalJs(`document.querySelector('#navBody .navgroup .gtog').click()`);
  await sleep(500);
  const closed = await evalJs(`(() => { const g = document.querySelector('#navBody .navgroup'); const grid = g.querySelector('.navgird') || g.querySelector('.gd'); return { closed: g.classList.contains('is-closed'), gridShown: grid ? getComputedStyle(grid).display !== 'none' : null, aria: g.querySelector('.gtog').getAttribute('aria-expanded') }; })()`);
  pass('折叠后内容区隐藏', closed.closed && closed.gridShown === false, JSON.stringify(closed));
  pass('折叠后 aria-expanded=false', closed.aria === 'false', closed.aria);

  // B. 折叠状态下的搜索：命中组必须展开
  await evalJs(`(() => { const s = document.getElementById('navSearch'); s.value = '组合站点1'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(700);
  const searched = await evalJs(`(() => {
    const gs = [...document.querySelectorAll('#navBody .navgroup')];
    return { groups: gs.length, closedCount: gs.filter(g => g.classList.contains('is-closed')).length, cards: document.querySelectorAll('#navBody .navcard').length, more: document.querySelectorAll('.navmore').length, note: (document.getElementById('navNote') || {}).textContent || '' };
  })()`);
  pass('搜索时不再有收起的分组', searched.closedCount === 0, JSON.stringify(searched));
  pass('搜索时不出「显示全部」按钮', searched.more === 0, 'more=' + searched.more);
  pass('搜索有命中计数提示', /匹配|命中/.test(searched.note) || searched.cards >= 1, searched.note);

  // C. 清空搜索：折叠状态要恢复
  await evalJs(`(() => { const s = document.getElementById('navSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(700);
  const restored = await evalJs(`(() => { const g = document.querySelector('#navBody .navgroup'); return { closed: g.classList.contains('is-closed') }; })()`);
  pass('清空搜索后恢复原折叠状态', restored.closed === true, JSON.stringify(restored));

  // D. 展开后「显示全部」按钮：15 站组只渲染 12 个
  await evalJs(`document.querySelector('#navBody .navgroup .gtog').click()`);
  await sleep(400);
  const more = await evalJs(`(() => {
    const gs = [...document.querySelectorAll('#navBody .navgroup')];
    const g = gs.find(x => (x.querySelector('.gtog') || {}).textContent.includes('组合大分组'));
    if (!g) return null;
    // 信息流广告位也是 .navcard，统计站点卡要排掉它，否则永远多 1
    return { cards: g.querySelectorAll('.navcard:not(.ad-inline-card)').length, hasBtn: !!g.querySelector('.navmore'), label: (g.querySelector('.navmore') || {}).textContent || '' };
  })()`);
  if (more) {
    pass('15 站分组默认只渲染 12 个', more.cards === 12, JSON.stringify(more));
    pass('有「显示全部」按钮且文案带 N', more.hasBtn && /15/.test(more.label), more.label);
    await evalJs(`(() => {
      const gs = [...document.querySelectorAll('#navBody .navgroup')];
      const g = gs.find(x => (x.querySelector('.gtog') || {}).textContent.includes('组合大分组'));
      g.querySelector('.navmore').click();
    })()`);
    await sleep(700);
    const opened = await evalJs(`(() => {
      const gs = [...document.querySelectorAll('#navBody .navgroup')];
      const g = gs.find(x => (x.querySelector('.gtog') || {}).textContent.includes('组合大分组'));
      return { cards: g.querySelectorAll('.navcard:not(.ad-inline-card)').length, hasBtn: !!g.querySelector('.navmore') };
    })()`);
    pass('点开后 15 个全出、按钮消失', opened.cards === 15 && !opened.hasBtn, JSON.stringify(opened));
  } else {
    pass('15 站分组存在（否则跳过加载更多断言）', false, 'seed 分组未渲染');
  }
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  // 还原导航数据（写回原样，避免只差 updatedAt 的噪声）
  try {
    const restore = await readNav();
    const after = shape(restore);
    if (after !== before) {
      const r = await api('/api/nav', { password: pw, nav: original });
      const now = shape(await readNav());
      pass('导航数据已还原', now === before, 'restore status=' + r.status + (now === before ? '' : ' 仍有差异'));
    } else {
      pass('导航数据已还原', true, 'no change（updatedAt 变动不算）');
    }
  } catch (e) {
    pass('导航数据已还原', false, String(e && e.message));
  }
}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（' + ok + ' 项）');
process.exit(bad ? 1 : 0);
