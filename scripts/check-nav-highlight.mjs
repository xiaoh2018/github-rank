// 导航页搜索高亮门禁：站名/描述/分组名命中处加 <mark>、命中计数、清空复原。
// 用法：先起 dev-server（8123），再 node scripts/check-nav-highlight.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9650 + Math.floor(Math.random() * 250);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-navhl-'));
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
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const openNav = async () => {
  await send('Page.navigate', { url: base + '/nav?v=' + Date.now() });
  await sleep(2200);
};
const search = async (text) => {
  await evalJs(`(() => { const i = document.getElementById('navSearch'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(350);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await openNav();
  await evalJs(`(() => { try { localStorage.removeItem('ghrank-nav-closed'); } catch (e) {} return 1; })()`);
  await openNav();

  console.log('== 1. 基线 ==');
  const base1 = await evalJs(`(() => ({
    cards: document.querySelectorAll('#navBody .navcard').length,
    marks: document.querySelectorAll('#navBody .hitmark').length,
    count: (document.getElementById('navCount') || {}).textContent || ''
  }))()`);
  ok('有导航卡片', base1 && base1.cards > 0, base1 && base1.cards);
  ok('未搜索时没有高亮', base1 && base1.marks === 0, base1 && base1.marks);
  ok('计数显示站点总数', base1 && /共\s*\d+\s*个站点/.test(base1.count), base1 && base1.count);

  console.log('== 2. 搜站名：片段高亮 + 计数 ==');
  const firstName = await evalJs(`(() => { const a = document.querySelector('#navBody .navcard b'); return a ? a.textContent.trim() : ''; })()`);
  const frag = String(firstName || '').slice(0, 2);
  ok('取到站名片段', frag.length === 2, firstName);
  await search(frag.toLowerCase());
  const s1 = await evalJs(`(() => {
    const marks = Array.from(document.querySelectorAll('#navBody .hitmark'));
    const nm = marks.find(m => m.closest('.navcard b'));
    const cs = nm ? getComputedStyle(nm).backgroundColor : '';
    return {
      marks: marks.length,
      texts: marks.map(m => m.textContent).join('|'),
      inName: !!nm,
      bg: cs,
      cards: document.querySelectorAll('#navBody .navcard').length,
      count: (document.getElementById('navCount') || {}).textContent || ''
    };
  })()`);
  ok('站名命中处出现 <mark>', s1 && s1.inName === true, JSON.stringify(s1));
  ok('小写输入也能命中（不区分大小写）', !!s1 && s1.texts.split('|').every((t) => t.toLowerCase() === frag.toLowerCase()), s1 && s1.texts);
  ok('高亮底色不是透明', s1 && s1.bg && s1.bg !== 'rgba(0, 0, 0, 0)' && s1.bg !== 'transparent', s1 && s1.bg);
  ok('过滤后卡片数不超过原来', s1 && s1.cards > 0 && s1.cards <= base1.cards, s1 && s1.cards);
  ok('计数显示「匹配 N / M 个」', s1 && /匹配\s*\d+\s*\/\s*\d+\s*个/.test(s1.count), s1 && s1.count);

  console.log('== 3. 搜描述：描述里也高亮 ==');
  const descFrag = await evalJs(`(() => { const s = document.querySelector('#navBody .navcard small'); return s ? s.textContent.trim().slice(0, 2) : ''; })()`);
  if (descFrag.length === 2) {
    await search(descFrag);
    const s2 = await evalJs(`(() => ({
      inDesc: !!document.querySelector('#navBody .navcard small .hitmark'),
      marks: document.querySelectorAll('#navBody .hitmark').length
    }))()`);
    ok('描述命中处出现 <mark>', s2 && s2.inDesc === true, JSON.stringify(s2));
  } else {
    ok('描述命中处出现 <mark>', false, '数据里没有描述文本');
  }

  console.log('== 4. 搜分组名：分组标题也高亮 ==');
  const gname = await evalJs(`(() => { const b = document.querySelector('.navgroup .gtog'); if (!b) return ''; return b.textContent.replace(/\\d+\\s*个$/, '').replace('▼', '').trim(); })()`);
  const gfrag = String(gname || '').slice(0, 2);
  ok('取到分组名片段', gfrag.length === 2, gname);
  await search(gfrag);
  const s3 = await evalJs(`(() => ({
    inHead: !!document.querySelector('.navgroup > h3 .hitmark'),
    inJump: !!document.querySelector('.navjump .hitmark'),
    jumped: (document.querySelector('.navjump .nj') || {}).textContent || ''
  }))()`);
  ok('分组标题命中处出现 <mark>', s3 && s3.inHead === true, JSON.stringify(s3));
  ok('分类快捷跳转胶囊也高亮', s3 && s3.inJump === true, s3 && s3.jumped);

  console.log('== 5. 清空复原 ==');
  await search('');
  const s4 = await evalJs(`(() => ({
    marks: document.querySelectorAll('#navBody .hitmark, .navjump .hitmark').length,
    cards: document.querySelectorAll('#navBody .navcard').length,
    count: (document.getElementById('navCount') || {}).textContent || ''
  }))()`);
  ok('清空后没有残留高亮', s4 && s4.marks === 0, s4 && s4.marks);
  ok('清空后卡片恢复', s4 && s4.cards === base1.cards, s4 && s4.cards + ' vs ' + base1.cards);
  ok('清空后计数恢复总数', s4 && /共\s*\d+\s*个站点/.test(s4.count), s4 && s4.count);

  console.log('== 6. 搜不到时的空态 ==');
  await search('ZZQ不存在的站点');
  const s5 = await evalJs(`(() => ({ note: (document.querySelector('#navBody .navempty') || {}).textContent || '', marks: document.querySelectorAll('.hitmark').length }))()`);
  ok('搜不到显示空态文案', /没有匹配的站点/.test(s5 && s5.note), s5 && s5.note);
  ok('空态时无高亮残留', s5 && s5.marks === 0, s5 && s5.marks);
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}

console.log(fails ? '\n失败 ' + fails + ' 项' : '\n全部通过');
process.exit(fails ? 1 : 0);
