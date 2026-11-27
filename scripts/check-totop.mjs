// 返回顶部按钮门禁：/articles 与 /faq 都有、滚动后出现、点击回顶、打印时隐藏。
// 用法：先起 dev-server（8123），再 node scripts/check-totop.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9680 + Math.floor(Math.random() * 240);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-totop-'));
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
const open = async (p) => { await send('Page.navigate', { url: base + p + '?v=' + Date.now() }); await sleep(2200); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 700, deviceScaleFactor: 1, mobile: false });

// TOTOP_STUB_ON：文章只有 2 篇时 /articles 页面不够长，「返回顶部」压根不会出现。
// 这里把 /data/articles.json 换成 12 篇（只在内存里），让页面足够长，测的是按钮本身而不是数据量。
const STUB_ARTICLES = Array.from({ length: 12 }, (_, i) => ({
  id: 'totop-' + (i + 1),
  slug: 'tech/totop-' + (i + 1),
  title: '返回顶部测试第 ' + (i + 1) + ' 篇',
  date: '2026-11-2' + (i % 9),
  summary: '这一篇只为了让列表够长，好让「返回顶部」按钮出现。'.repeat(3),
  body: '正文。'.repeat(80),
  category: '技术',
  tags: ['测试'],
}));
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.setBypassServiceWorker', { bypass: true });
await send('Fetch.enable', { patterns: [{ urlPattern: '*/data/articles.json*', requestStage: 'Request' }] });
ws.addEventListener('message', async (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method !== 'Fetch.requestPaused') return;
  const body = Buffer.from(JSON.stringify(STUB_ARTICLES), 'utf8').toString('base64');
  await send('Fetch.fulfillRequest', {
    requestId: m.params.requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/json; charset=utf-8' },
      { name: 'cache-control', value: 'no-store' },
    ],
    body,
  });
});

for (const page of ['/articles', '/faq']) {
  console.log('== ' + page + ' ==');
  await open(page);
  const init = await evalJs(`(() => {
    const b = document.getElementById('totop');
    return { has: !!b, hidden: b ? b.hidden : null, label: b ? (b.getAttribute('aria-label') || '') : '', y: Math.round(window.scrollY), docH: document.documentElement.scrollHeight };
  })()`);
  ok(page + ' 有返回顶部按钮', init && init.has, JSON.stringify(init));
  ok(page + ' 按钮有无障碍名称', init && init.label === '返回顶部', JSON.stringify(init));
  ok(page + ' 页面顶部时按钮隐藏', init && init.hidden === true, JSON.stringify(init));
  ok(page + ' 页面足够长（可滚动超过 420px）', init && init.docH - 700 > 420, JSON.stringify(init));

  await evalJs(`window.scrollTo(0, 1200)`);
  await sleep(600);
  const scrolled = await evalJs(`(() => { const b = document.getElementById('totop'); return { hidden: b ? b.hidden : null, y: Math.round(window.scrollY) }; })()`);
  ok(page + ' 滚动后按钮出现', scrolled && scrolled.hidden === false && scrolled.y > 400, JSON.stringify(scrolled));

  await evalJs(`document.getElementById('totop').click()`);
  await sleep(1400);
  const back = await evalJs(`Math.round(window.scrollY)`);
  ok(page + ' 点击后回到顶部', typeof back === 'number' && back < 20, String(back));

  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(200);
  const printed = await evalJs(`(() => { const b = document.getElementById('totop'); return b ? getComputedStyle(b).display : null; })()`);
  ok(page + ' 打印时不显示', printed === 'none', String(printed));
  await send('Emulation.setEmulatedMedia', { media: '' });
}

console.log(fails ? '\n' + fails + ' FAILED' : '\n全部通过');
try { ws.close(); } catch {}
try { child.kill(); } catch {}
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
