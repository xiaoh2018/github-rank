// 导航页排序门禁：后台「导航页」面板的分类 ↑↓ 与组内站点 ↑↓ 要能真正换位，且不保存时重进还原。
// 用法：先起 dev-server（8123），再 node scripts/check-nav-order.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9650 + Math.floor(Math.random() * 250);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-nav-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

let target;
for (let i = 0; i < 40 && !target; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 220) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const login = async () => {
  await sleep(1600);
  await evalJs(`(() => { const p = document.querySelector('#pw'); if (p) { p.value = ${JSON.stringify(PW)}; const f = document.querySelector('#loginForm'); if (f) f.requestSubmit(); } return 1; })()`);
  await sleep(1500);
  await evalJs(`(() => { const n = document.querySelector('.nav[data-tab="nav"]'); if (n) n.click(); return 1; })()`);
  await sleep(1200);
};

const navBefore = await (await fetch(base + '/api/nav?v=' + Date.now())).json().catch(() => ({}));
const groups = ((navBefore.nav || {}).groups) || [];
console.log('线上导航分类：' + groups.length + ' 个，站点合计 ' + groups.reduce((n, g) => n + ((g.items || []).length), 0) + ' 个');

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/admin' });
await login();

console.log('== 1. 按钮都在 ==');
const cnt = await evalJs(`(() => ({
  cards: document.querySelectorAll('#navAdmin .nav-g').length,
  gup: document.querySelectorAll('#navAdmin [data-gup]').length,
  gdn: document.querySelectorAll('#navAdmin [data-gdn]').length,
  sup: document.querySelectorAll('#navAdmin [data-sup]').length,
  sdn: document.querySelectorAll('#navAdmin [data-sdn]').length,
  rows: document.querySelectorAll('#navAdmin tbody tr').length,
}))()`);
ok('导航面板打开了', cnt && cnt.cards > 0, JSON.stringify(cnt));
if (cnt && cnt.cards > 0) {
  ok('每个分类都有 ↑ ↓', cnt.gup === cnt.cards && cnt.gdn === cnt.cards, JSON.stringify(cnt));
  ok('每个站点都有 ↑ ↓', cnt.sup === cnt.rows && cnt.sdn === cnt.rows, JSON.stringify({ sup: cnt.sup, sdn: cnt.sdn, rows: cnt.rows }));
  const edge = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('#navAdmin .nav-g')];
    const f = cards[0].querySelector('[data-gup]');
    const l = cards[cards.length - 1].querySelector('[data-gdn]');
    const rows = [...document.querySelectorAll('#navAdmin tbody tr')];
    const fu = rows.length ? rows[0].querySelector('[data-sup]') : null;
    const ld = rows.length ? rows[rows.length - 1].querySelector('[data-sdn]') : null;
    return { firstGup: !!(f && f.disabled), lastGdn: !!(l && l.disabled), firstSup: !!(fu && fu.disabled), lastSdn: !!(ld && ld.disabled) };
  })()`);
  ok('第一个分类上移 / 最后一个分类下移是禁用的', edge.firstGup && edge.lastGdn, JSON.stringify(edge));
  ok('组内第一条上移 / 最后一条下移是禁用的', edge.firstSup && edge.lastSdn, JSON.stringify(edge));
}

console.log('== 2. 分类换位 ==');
const names0 = await evalJs(`[...document.querySelectorAll('#navAdmin input[data-gf="name"]')].map(i => i.value)`);
const afterG = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('#navAdmin .nav-g')];
  if (cards.length < 2) return 'skip';
  const b = cards[0].querySelector('[data-gdn]');
  if (!b) return 'no-button';
  b.click();
  return [...document.querySelectorAll('#navAdmin input[data-gf="name"]')].map(i => i.value);
})()`);
if (afterG === 'skip') {
  console.log('  SKIP  只有一个分类，跳过换位检查');
} else {
  ok('第一个分类下移后与前一个换了位置', Array.isArray(afterG) && Array.isArray(names0) && afterG[0] === names0[1] && afterG[1] === names0[0], JSON.stringify({ names0, afterG }));
  const backNames = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('#navAdmin .nav-g')];
    const b = cards[1].querySelector('[data-gup]');
    if (!b) return 'no-button';
    b.click();
    return [...document.querySelectorAll('#navAdmin input[data-gf="name"]')].map(i => i.value);
  })()`);
  ok('再上移回来顺序复原', JSON.stringify(backNames) === JSON.stringify(names0), JSON.stringify({ names0, backNames }));
}

console.log('== 3. 组内站点换位 ==');
const siteNames0 = await evalJs(`[...document.querySelectorAll('#navAdmin tbody tr input[data-f="name"]')].map(i => i.value).slice(0, 3)`);
const afterS = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('#navAdmin tbody tr')];
  if (rows.length < 2) return 'skip';
  const b = rows[1].querySelector('[data-sup]');
  if (!b) return 'no-button';
  b.click();
  return [...document.querySelectorAll('#navAdmin tbody tr input[data-f="name"]')].map(i => i.value).slice(0, 3);
})()`);
if (afterS === 'skip') {
  console.log('  SKIP  站点太少，跳过换位检查');
} else {
  ok('第二条站点上移后与前一条换位', Array.isArray(afterS) && afterS[0] === siteNames0[1] && afterS[1] === siteNames0[0], JSON.stringify({ siteNames0, afterS }));
}

console.log('== 4. 不保存，重进要还原 ==');
await send('Page.navigate', { url: base + '/admin' });
await login();
const namesBack = await evalJs(`[...document.querySelectorAll('#navAdmin input[data-gf="name"]')].map(i => i.value)`);
const sitesBack = await evalJs(`[...document.querySelectorAll('#navAdmin tbody tr input[data-f="name"]')].map(i => i.value).slice(0, 3)`);
ok('分类顺序回到线上数据', JSON.stringify(namesBack) === JSON.stringify(names0), JSON.stringify({ names0, namesBack }));
ok('站点顺序回到线上数据', JSON.stringify(sitesBack) === JSON.stringify(siteNames0), JSON.stringify({ siteNames0, sitesBack }));
const navAfter = await (await fetch(base + '/api/nav?v=' + Date.now())).json().catch(() => ({}));
const gAfter = ((navAfter.nav || {}).groups) || [];
ok('线上分类数量没变', gAfter.length === groups.length, groups.length + ' -> ' + gAfter.length);

// 保存链路：换位后点「保存导航页」必须真的落盘；无论成败，finally 里用 API 还原原始结构。
const originalNav = (navBefore.nav || { groups: [] });
const fetchNav = async () => {
  const j = await (await fetch(base + '/api/nav?v=' + Date.now())).json().catch(() => ({}));
  return ((j.nav || {}).groups) || [];
};
const clickSave = async () => {
  await evalJs(`(() => { const b = document.querySelector('#pane-nav [data-save="nav"]'); if (b) b.click(); return 1; })()`);
  await sleep(1800);
};

try {
  console.log('== 5. 换位后保存要真的落盘 ==');
  const swapOk = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('#navAdmin .nav-g')];
    if (cards.length < 2) return 'skip';
    const b = cards[0].querySelector('[data-gdn]');
    if (!b) return 'no-button';
    b.click();
    return [...document.querySelectorAll('#navAdmin input[data-gf="name"]')].map(i => i.value);
  })()`);
  if (swapOk === 'skip' || swapOk === 'no-button') {
    console.log('  SKIP  分类不足，跳过保存检查');
  } else {
    await clickSave();
    const savedGroups = await fetchNav();
    ok('保存后线上第一个分类变成原来的第二个', (savedGroups[0] || {}).name === names0[1], JSON.stringify({ want: names0[1], got: (savedGroups[0] || {}).name }));
    ok('保存后分类数量没变', savedGroups.length === groups.length, groups.length + ' -> ' + savedGroups.length);
    await evalJs(`(() => {
      const cards = [...document.querySelectorAll('#navAdmin .nav-g')];
      const b = cards[1] ? cards[1].querySelector('[data-gup]') : null;
      if (b) b.click();
      return 1;
    })()`);
    await clickSave();
    const backGroups = await fetchNav();
    ok('再保存一次顺序复原', JSON.stringify(backGroups.map((g) => g.name)) === JSON.stringify(names0), JSON.stringify({ names0, now: backGroups.map((g) => g.name) }));
  }
} finally {
  const nowGroups = await fetchNav();
  if (JSON.stringify(nowGroups.map((g) => g.name)) !== JSON.stringify(names0)) {
    await fetch(base + '/api/nav', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW, nav: originalNav }),
    }).catch(() => null);
    await sleep(700);
    const fixed = await fetchNav();
    console.log('  INFO  已用 API 还原导航结构：' + (fixed.length === groups.length ? 'ok' : '请人工检查 data/nav.json'));
  }
}

console.log(fails ? `导航排序门禁 ${fails} 项失败` : '导航排序门禁全部通过');
try { await send('Browser.close'); } catch {}
child.kill();
process.exit(fails ? 1 : 0);
