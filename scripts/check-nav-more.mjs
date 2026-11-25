// 导航页分组「加载更多」门禁：长分组先只显示 12 个 → 点「显示全部 N 个」全展开 → 搜索时不截断。
// 用法：先起 dev-server（8123），再 node scripts/check-nav-more.mjs [--shot 输出png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shotArg = process.argv.indexOf('--shot');
const shotOut = shotArg > -1 ? process.argv[shotArg + 1] : '';
const GNAME = '__门禁__大分组';
const N = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

const postNav = async (nav) => {
  const r = await fetch(base + '/api/nav', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW, nav }) });
  return r.json().catch(() => ({}));
};
const getNav = async () => {
  const j = await (await fetch(base + '/data/nav.json')).json().catch(() => null);
  return j && Array.isArray(j.groups) ? j : { groups: [] };
};

const original = await getNav();
const bigGroup = {
  name: GNAME,
  desc: '门禁临时分组，跑完会删掉',
  items: Array.from({ length: N }, (_, i) => ({ name: '门禁站点 ' + (i + 1), url: 'https://example.com/nm' + (i + 1), desc: '用来验证加载更多', icon: '' })),
};
const withBig = { groups: original.groups.concat([bigGroup]) };
const seeded = await postNav(withBig);
if (!seeded || !seeded.ok) { console.error('造分组失败：' + JSON.stringify(seeded).slice(0, 200)); process.exit(1); }

let target;
const port = 9750 + Math.floor(Math.random() * 200);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-navmore-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 40 && !target; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); await postNav(original); process.exit(1); }

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

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/?page=nav&v=' + Date.now() });
  await sleep(2800);

  console.log('== 1. 长分组先只显示 12 个 ==');
  const first = await evalJs(`(() => {
    const secs = [...document.querySelectorAll('.navgroup')];
    const sec = secs.find(s => s.querySelector('.gtog') && s.querySelector('.gtog').textContent.indexOf('大分组') > -1);
    if (!sec) return null;
    return { cards: sec.querySelectorAll('.navcard:not(.ad-inline-card)').length, cnt: sec.querySelector('.cnt') ? sec.querySelector('.cnt').textContent : '', more: sec.querySelector('.navmore') ? sec.querySelector('.navmore').textContent : '' };
  })()`);
  ok('找到门禁分组', !!first, JSON.stringify(first));
  ok('只渲染前 12 个卡片', first && first.cards === 12, first && first.cards);
  ok('分组计数仍是 15 个', first && /15/.test(first.cnt), first && first.cnt);
  ok('有「显示全部 15 个」按钮', first && /显示全部 15 个/.test(first.more || ''), first && first.more);

  console.log('== 2. 点它展开 ==');
  const after = await evalJs(`(() => {
    const secs = [...document.querySelectorAll('.navgroup')];
    const sec = secs.find(s => s.querySelector('.gtog') && s.querySelector('.gtog').textContent.indexOf('大分组') > -1);
    const btn = sec.querySelector('.navmore');
    btn.click();
    return new Promise(res => setTimeout(() => {
      const sec2 = [...document.querySelectorAll('.navgroup')].find(s => s.querySelector('.gtog') && s.querySelector('.gtog').textContent.indexOf('大分组') > -1);
      res({ cards: sec2.querySelectorAll('.navcard:not(.ad-inline-card)').length, more: !!sec2.querySelector('.navmore') });
    }, 260));
  })()`);
  ok('展开后 15 个卡片都在', after && after.cards === N, after && after.cards);
  ok('按钮消失', after && after.more === false, after && after.more);

  console.log('== 3. 搜索时不截断 ==');
  const searched = await evalJs(`(() => {
    const inp = document.getElementById('navSearch');
    inp.value = '门禁站点';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise(res => setTimeout(() => {
      const sec = [...document.querySelectorAll('.navgroup')].find(s => s.querySelector('.gtog') && s.querySelector('.gtog').textContent.indexOf('大分组') > -1);
      res({ cards: sec ? sec.querySelectorAll('.navcard:not(.ad-inline-card)').length : -1, more: sec ? !!sec.querySelector('.navmore') : null, cnt: sec && sec.querySelector('.cnt') ? sec.querySelector('.cnt').textContent : '' });
    }, 300));
  })()`);
  ok('搜索命中 15 个全显示', searched && searched.cards === N, searched && searched.cards);
  ok('搜索时没有「显示全部」按钮', searched && searched.more === false, searched && searched.more);

  if (shotOut) {
    await evalJs(`(() => { const inp=document.getElementById('navSearch'); inp.value=''; inp.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
    await sleep(500);
    await evalJs(`(() => { const sec=[...document.querySelectorAll('.navgroup')].find(s=>s.querySelector('.gtog')&&s.querySelector('.gtog').textContent.indexOf('大分组')>-1); if(sec) sec.scrollIntoView({block:'center'}); return 1; })()`);
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(shotOut, Buffer.from(shot.result.data, 'base64'));
    console.log('saved ' + shotOut + ' ' + fs.statSync(shotOut).size + 'B');
  }
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  const back = await postNav(original);
  const now = await getNav();
  console.log('还原导航：' + (back && back.ok ? 'ok' : '失败') + '，当前 ' + now.groups.length + ' 个分组，残留门禁分组 ' + now.groups.filter((g) => g.name === GNAME).length);
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
