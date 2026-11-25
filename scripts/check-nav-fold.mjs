// 导航页分组折叠门禁：标题可点收起/展开、状态记住、搜索时自动展开、点分类快捷跳转自动展开。
// 用法：先起 dev-server（8123），再 node scripts/check-nav-fold.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9650 + Math.floor(Math.random() * 250);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-fold-'));
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
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const openNav = async () => {
  await send('Page.navigate', { url: base + '/nav?v=' + Date.now() });
  await sleep(2200);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await openNav();
// 每次从干净状态开始
await evalJs(`(() => { try { localStorage.removeItem('ghrank-nav-closed'); } catch (e) {} return 1; })()`);
await openNav();

console.log('== 1. 分组标题可点 ==');
const head = await evalJs(`(() => ({
  groups: document.querySelectorAll('.navgroup').length,
  togs: document.querySelectorAll('.navgroup .gtog').length,
  expanded: [...document.querySelectorAll('.navgroup .gtog')].every(b => b.getAttribute('aria-expanded') === 'true'),
}))()`);
ok('每个分组都有折叠按钮', head && head.groups > 0 && head.togs === head.groups, JSON.stringify(head));
ok('默认全部展开', head && head.expanded, JSON.stringify(head));

console.log('== 2. 点一下收起 ==');
const folded = await evalJs(`(() => {
  const sec = document.querySelector('.navgroup');
  const key = sec.getAttribute('data-gkey');
  sec.querySelector('.gtog').click();
  const grid = sec.querySelector('.navgird');
  return {
    closed: sec.classList.contains('is-closed'),
    aria: sec.querySelector('.gtog').getAttribute('aria-expanded'),
    gridDisplay: getComputedStyle(grid).display,
    stored: (() => { try { return localStorage.getItem('ghrank-nav-closed'); } catch (e) { return 'n/a'; } })(),
    key,
  };
})()`);
ok('分组变成收起状态', folded && folded.closed === true, JSON.stringify(folded));
ok('aria-expanded 变 false', folded && folded.aria === 'false', JSON.stringify(folded));
ok('内容区被隐藏', folded && folded.gridDisplay === 'none', JSON.stringify(folded));
ok('收起状态写进了 localStorage', folded && String(folded.stored || '').indexOf(String(folded.key)) >= 0, JSON.stringify({ stored: folded && folded.stored, key: folded && folded.key }));

console.log('== 3. 刷新后状态保留 ==');
await openNav();
const kept = await evalJs(`(() => { const sec = document.querySelector('.navgroup'); return { closed: sec.classList.contains('is-closed'), aria: sec.querySelector('.gtog').getAttribute('aria-expanded') }; })()`);
ok('刷新后仍是收起', kept && kept.closed === true && kept.aria === 'false', JSON.stringify(kept));

console.log('== 4. 再点一下展开 ==');
const opened = await evalJs(`(() => { const sec = document.querySelector('.navgroup'); sec.querySelector('.gtog').click(); return { closed: sec.classList.contains('is-closed'), display: getComputedStyle(sec.querySelector('.navgird')).display }; })()`);
ok('点第二次展开', opened && opened.closed === false && opened.display !== 'none', JSON.stringify(opened));

console.log('== 5. 搜索时自动展开被收起的分组 ==');
const searchAuto = await evalJs(`(() => {
  const sec = document.querySelector('.navgroup');
  sec.querySelector('.gtog').click();               // 先收起
  const before = sec.classList.contains('is-closed');
  const inp = document.getElementById('navSearch');
  inp.value = '项目';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return { before };
})()`);
await sleep(600);
const auto = await evalJs(`(() => {
  const groups = [...document.querySelectorAll('.navgroup')];
  return { closedCount: groups.filter(g => g.classList.contains('is-closed')).length, groups: groups.length, count: (document.getElementById('navCount') || {}).textContent || '' };
})()`);
ok('搜索时不再有收起的分组', auto && auto.closedCount === 0, JSON.stringify({ searchAuto, auto }));
ok('搜索结果有计数提示', auto && /匹配/.test(String(auto.count)), JSON.stringify(auto));

console.log('== 6. 点分类快捷跳转会自动展开 ==');
await evalJs(`(() => { const inp = document.getElementById('navSearch'); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
await sleep(500);
const jump = await evalJs(`(() => {
  const sec = document.querySelectorAll('.navgroup')[0];
  sec.querySelector('.gtog').click();               // 收起第一组
  const chip = document.querySelector('.navjump .nj');
  if (!chip) return 'no-chip';
  chip.click();
  return { closed: sec.classList.contains('is-closed'), aria: sec.querySelector('.gtog').getAttribute('aria-expanded') };
})()`);
if (jump === 'no-chip') {
  console.log('  SKIP  没有分类快捷跳转');
} else {
  ok('点快捷跳转后目标分组自动展开', jump && jump.closed === false && jump.aria === 'true', JSON.stringify(jump));
}

console.log(fails ? `导航折叠门禁 ${fails} 项失败` : '导航折叠门禁全部通过');
try { await send('Browser.close'); } catch {}
child.kill();
process.exit(fails ? 1 : 0);
