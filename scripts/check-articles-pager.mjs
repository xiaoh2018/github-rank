// 文章列表分页门禁：造 12 篇文章 → 每页 9 篇、页码正确、翻页生效、搜索回第 1 页、跑完清理。
// 用法：先起 dev-server（8123），再 node scripts/check-articles-pager.mjs [--shot]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOT = process.argv.includes('--shot');
const SEED = 12;
const TAG = '__page__';

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (body) => {
  const r = await fetch(base + '/api/articles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
};

// 1) 造数据
const ids = [];
for (let i = 1; i <= SEED; i++) {
  const j = await post({
    password: PW,
    action: 'add',
    article: { title: TAG + '测试文章 ' + i, summary: '第 ' + i + ' 篇分页测试', body: '这是第 ' + i + ' 篇的正文，用来验证分页。', category: '技术', date: '2026-11-2' + (i % 10) },
  });
  if (j && j.ok) {
    const arr = Array.isArray(j.articles) ? j.articles : [];
    const hit = arr.filter((a) => String(a.title || '').indexOf(TAG) === 0).pop();
    if (hit && hit.id) ids.push(hit.id);
  } else {
    console.log('  WARN  造数据失败：' + JSON.stringify(j).slice(0, 120));
  }
}
console.log('造了 ' + ids.length + ' 篇测试文章');

const cleanup = async () => {
  for (const id of ids) await post({ password: PW, action: 'remove', id });
  const list = await (await fetch(base + '/data/articles.json?v=' + Date.now())).json().catch(() => null);
  const arr = Array.isArray(list) ? list : ((list && list.articles) || []);
  return arr.filter((a) => String(a.title || '').indexOf(TAG) === 0).length;
};

const port = 9650 + Math.floor(Math.random() * 250);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pager-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
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

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/articles?v=' + Date.now() });
  await sleep(2200);

  console.log('== 1. 第 1 页 ==');
  const p1 = await evalJs(`(() => ({
    cards: document.querySelectorAll('#cards .acard').length,
    pager: (() => { const p = document.querySelector('#apager'); return p ? { hidden: p.hidden, text: p.textContent.replace(/\\s+/g, ' ').trim() } : null; })(),
    total: document.querySelectorAll('#chips .chip b').length ? document.querySelector('#chips .chip b').textContent : '',
  }))()`);
  ok('第 1 页渲染 9 张卡片', p1 && p1.cards === 9, JSON.stringify(p1));
  ok('分页条可见', p1 && p1.pager && p1.pager.hidden === false, JSON.stringify(p1 && p1.pager));
  ok('页码文案正确', p1 && p1.pager && /第 1 \/ 2 页/.test(p1.pager.text) && /共 15 篇/.test(p1.pager.text), JSON.stringify(p1 && p1.pager && p1.pager.text));
  const prevDisabled = await evalJs(`(() => { const b = document.querySelector('#apager [data-page]'); return !!(b && b.disabled); })()`);
  ok('第 1 页「上一页」是禁用的', prevDisabled === true, String(prevDisabled));

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { captureBeyondViewport: true, format: 'png' });
    if (shot && shot.result && shot.result.data) {
      fs.writeFileSync(path.join('docs', 'shots', 'articles-pager.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  截图 docs/shots/articles-pager.png');
    }
  }

  console.log('== 2. 点下一页 ==');
  const p2 = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('#apager [data-page]')];
    const next = btns[btns.length - 1];
    if (!next) return 'no-button';
    next.click();
    return {
      cards: document.querySelectorAll('#cards .acard').length,
      text: document.querySelector('#apager').textContent.replace(/\\s+/g, ' ').trim(),
      nextDisabled: !![...document.querySelectorAll('#apager [data-page]')].pop().disabled,
      firstTitle: (document.querySelector('#cards .acard h3') || {}).textContent || '',
    };
  })()`);
  ok('第 2 页只剩 6 张卡片', p2 && p2.cards === 6, JSON.stringify(p2));
  ok('第 2 页页码文案正确', p2 && /第 2 \/ 2 页/.test(p2.text), JSON.stringify(p2 && p2.text));
  ok('第 2 页「下一页」是禁用的', p2 && p2.nextDisabled === true, JSON.stringify(p2));

  console.log('== 3. 搜索回第 1 页 ==');
  const searched = await evalJs(`(() => {
    const s = document.querySelector('#search');
    s.value = '分页测试';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(500);
  const p3 = await evalJs(`(() => ({
    cards: document.querySelectorAll('#cards .acard').length,
    text: (document.querySelector('#apager') || {}).textContent || '',
    hidden: (document.querySelector('#apager') || {}).hidden,
  }))()`);
  ok('搜索后回到第 1 页（9 张）', p3 && p3.cards === 9, JSON.stringify(p3));
  ok('搜索后页码从 1 开始', p3 && /第 1 \/ 2 页/.test(String(p3.text).replace(/\\s+/g, ' ')), JSON.stringify(p3.text));

  console.log('== 4. 新关键词只剩少量结果时隐藏分页 ==');
  await evalJs(`(() => { const s = document.querySelector('#search'); s.value = '__page__测试文章 12'; s.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(500);
  const p4 = await evalJs(`(() => ({ cards: document.querySelectorAll('#cards .acard').length, hidden: document.querySelector('#apager').hidden }))()`);
  ok('只剩 1 篇时分页条隐藏', p4 && p4.cards === 1 && p4.hidden === true, JSON.stringify(p4));

  console.log('== 5. 打印样式里不打印分页条 ==');
  const printCss = await evalJs(`(() => { let n = 0; for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) { if (r.media && String(r.media.mediaText).indexOf('print') >= 0 && String(r.cssText).indexOf('.apager') >= 0) n++; } } catch (e) {} } return n; })()`);
  ok('print 媒体查询里隐藏了 .apager', printCss > 0, String(printCss));
} finally {
  const left = await cleanup();
  ok('测试文章清理干净', left === 0, '剩 ' + left + ' 篇');
  try { await send('Browser.close'); } catch {}
  child.kill();
}

console.log(fails ? `文章分页门禁 ${fails} 项失败` : '文章分页门禁全部通过');
process.exit(fails ? 1 : 0);
