// 阅读器「上/下一篇」门禁：点链接能换篇（原来 findArt 只认 id，点了会直接关阅读器）、
// 首尾有边界提示、键盘 ←/→ 到边界会闪提示而不是关掉或走反方向。
// 用法：先起 dev-server（8123），再 node scripts/check-reader-nav.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9600 + Math.floor(Math.random() * 200);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-rnav-'));
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
const open = async (u) => { await send('Page.navigate', { url: base + u + (u.indexOf('?') > -1 ? '&' : '?') + 'v=' + Date.now() }); await sleep(1800); };
// RN_NAV_STUB：线上只有 2 篇文章时测不了「中间那篇两个方向都有链接」「首尾边界」。
// 用 CDP 把 /data/articles.json 换成 4 篇（只存在内存里，不碰仓库数据）。
const RN_NAV_STUB = Array.from({ length: 4 }, (_, i) => ({
  id: 'rnav-' + (i + 1),
  slug: 'tech/rnav-' + (i + 1),
  title: '翻页测试第 ' + (i + 1) + ' 篇',
  date: '2026-11-0' + (9 - i),
  summary: '为了测阅读器翻页准备的假文章。',
  body: '正文。'.repeat(60),
  category: '技术',
  tags: ['测试'],
}));
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.setBypassServiceWorker', { bypass: true });
await send('Fetch.enable', { patterns: [{ urlPattern: '*/data/articles.json*', requestStage: 'Request' }] });
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method !== 'Fetch.requestPaused') return;
  const body = Buffer.from(JSON.stringify(RN_NAV_STUB), 'utf8').toString('base64');
  send('Fetch.fulfillRequest', {
    requestId: m.params.requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/json; charset=utf-8' },
      { name: 'cache-control', value: 'no-store' },
    ],
    body,
  });
});

const state = async () => evalJs(`(() => {
  const r = document.getElementById('reader');
  const nav = document.getElementById('rNav') || {};
  const newer = nav.querySelector && nav.querySelector('a[data-dir="newer"]');
  const older = nav.querySelector && nav.querySelector('a[data-dir="older"]');
  const limPrev = nav.querySelector && nav.querySelector('.rlim[data-lim="prev"]');
  const limNext = nav.querySelector && nav.querySelector('.rlim[data-lim="next"]');
  return {
    readerOpen: !!r && !r.hidden,
    title: (document.getElementById('rTitle') || {}).textContent || '',
    hasNewer: !!newer, hasOlder: !!older,
    limPrev: limPrev ? limPrev.textContent : '',
    limNext: limNext ? limNext.textContent : '',
    hitPrev: !!(limPrev && limPrev.classList.contains('is-hit')),
    hitNext: !!(limNext && limNext.classList.contains('is-hit')),
    href: location.pathname,
    cards: Array.from(document.querySelectorAll('.acard')).map(c => (c.querySelector('h3') || {}).textContent || '')
  };
})()`);

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await open('/articles');

  const base0 = await state();
  ok('列表里至少有 3 篇（否则没法测首尾）', base0 && base0.cards.length >= 3, base0 && base0.cards.length);
  ok('一开始阅读器是关的', base0 && base0.readerOpen === false);

  console.log('== 1. 第一篇（最新）：只有「下一篇」，上方是边界提示 ==');
  await evalJs(`document.querySelectorAll('.acard')[0].click()`);
  await sleep(700);
  const s1 = await state();
  ok('点卡片能打开阅读器', s1 && s1.readerOpen === true, s1 && s1.title);
  ok('第一篇没有「更新的一篇」链接', s1 && s1.hasNewer === false, s1 && s1.hasNewer);
  ok('第一篇显示「已经是第一篇」', s1 && /已经是第一篇/.test(s1.limPrev), s1 && s1.limPrev);
  ok('第一篇有「下一篇」（更旧的）链接', s1 && s1.hasOlder === true, s1 && s1.hasOlder);

  console.log('== 2. 点「下一篇」能换篇，而不是关掉阅读器（原 bug） ==');
  await evalJs(`document.querySelector('#rNav a[data-dir="older"]').click()`);
  await sleep(800);
  const s2 = await state();
  ok('阅读器仍然打开', s2 && s2.readerOpen === true, s2 && s2.readerOpen);
  ok('标题换成了第二篇', s2 && s2.title === base0.cards[1], s2 && s2.title + ' ≠ ' + base0.cards[1]);
  ok('地址栏换成第二篇的路径', s2 && /\/articles\/.+\.html$/.test(s2.href), s2 && s2.href);
  ok('第二篇两个方向都有链接', s2 && s2.hasNewer === true && s2.hasOlder === true);

  console.log('== 3. 点「上一篇」回到最新 ==');
  await evalJs(`document.querySelector('#rNav a[data-dir="newer"]').click()`);
  await sleep(800);
  const s3 = await state();
  ok('回到第一篇', s3 && s3.title === base0.cards[0], s3 && s3.title);
  ok('回到第一篇后又只剩「下一篇」', s3 && s3.hasNewer === false && s3.hasOlder === true);

  console.log('== 4. 键盘 → 一路走到最后一篇，再按一次给边界提示 ==');
  for (let i = 0; i < 5; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await sleep(450);
    const cur = await state();
    if (cur && cur.hasOlder === false) break;
  }
  const last = await state();
  ok('走到了最后一篇', last && last.hasOlder === false, last && last.title);
  ok('最后一篇显示「已经是最后一篇」', last && /已经是最后一篇/.test(last.limNext), last && last.limNext);
  ok('最后一篇阅读器仍打开', last && last.readerOpen === true);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(200);
  const hit = await state();
  ok('到底后按 → 阅读器不被关掉', hit && hit.readerOpen === true);
  ok('到底后按 → 边界提示闪一下', hit && hit.hitNext === true, hit && hit.hitNext);

  console.log('== 5. 键盘 ← 在最新一篇给边界提示 ==');
  for (let i = 0; i < 5; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await sleep(450);
    const cur = await state();
    if (cur && cur.hasNewer === false) break;
  }
  const first = await state();
  ok('回到了第一篇', first && first.hasNewer === false, first && first.title);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await sleep(200);
  const hit2 = await state();
  ok('最新一篇按 ← 阅读器不被关掉', hit2 && hit2.readerOpen === true);
  ok('最新一篇按 ← 边界提示闪一下', hit2 && hit2.hitPrev === true, hit2 && hit2.hitPrev);

  console.log('== 6. 深链直达最后一篇 ==');
  // 桩数据只活在浏览器里，服务端没有这些文章；深链必须用仓库里真实存在的最后一篇。
  const realArts = await (await fetch(base + '/data/articles.json')).json();
  const sorted = realArts.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const lastReal = sorted[sorted.length - 1];
  const deepPath = '/articles/' + String(lastReal.slug || lastReal.id).split('/').map(encodeURIComponent).join('/') + '.html';
  await send('Fetch.disable');  // 桩只服务前 5 段；深链是服务端渲染的真文章，客户端数据必须回到真实
  await send('Page.navigate', { url: base + deepPath + '?v=' + Date.now() });
  await sleep(1800);
  const s6 = await state();
  ok('深链能直接打开这篇', s6 && s6.readerOpen === true && s6.title === lastReal.title, s6 && s6.title + ' vs ' + lastReal.title);
  ok('深链打开时边界提示正确', s6 && s6.hasOlder === false && /已经是最后一篇/.test(s6.limNext), s6 && s6.limNext);
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
