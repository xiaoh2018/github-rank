// 门禁：文章页侧栏「最新文章」——规范地址、可点开阅读器、置顶优先、最多 5 条
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9700 + Math.floor(Math.random() * 120);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-side-'));
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });

let ok = 0, bad = 0;
function pass(name, cond, extra) { if (cond) { ok++; console.log('  PASS  ' + name); } else { bad++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); } }

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
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails));
  return r.result && r.result.result && r.result.result.value;
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/articles?v=' + Date.now() });
  await sleep(2000);

  const list = await evalJs(`(() => {
    const items = [...document.querySelectorAll('#recentList a')];
    return items.map(a => ({ href: a.getAttribute('href') || '', id: a.getAttribute('data-id') || '', title: (a.querySelector('span') || {}).textContent || '', day: (a.querySelector('small') || {}).textContent || '' }));
  })()`);
  pass('侧栏有「最新文章」条目', Array.isArray(list) && list.length >= 1, 'n=' + (list && list.length));
  pass('最多 5 条', list.length <= 5, 'n=' + list.length);
  pass('每条都是规范地址 /articles/….html', list.every((x) => /^\/articles\/.+\.html$/.test(x.href)), JSON.stringify(list.map((x) => x.href)));
  pass('每条都带 data-id', list.every((x) => x.id), '');
  pass('没有遗留 #id 形式', list.every((x) => x.href.charAt(0) !== '#'), '');

  const days = list.map((x) => x.day).filter(Boolean);
  let mono = true;
  for (let i = 1; i < days.length; i++) if (days[i] > days[i - 1]) mono = false;
  pass('按日期从新到旧（置顶优先）', mono, days.join(','));

  // 点第一条 → 阅读器打开、地址栏是它的规范地址、标题对得上
  await evalJs(`document.querySelector('#recentList a').click()`);
  await sleep(700);
  const after = await evalJs(`(() => {
    const r = document.getElementById('reader');
    const t = document.getElementById('rTitle');
    return { open: !!r && !r.hidden, path: location.pathname, title: t ? t.textContent.trim() : '' };
  })()`);
  pass('点侧栏条目打开了阅读器', after.open, JSON.stringify(after));
  pass('地址栏是规范地址', after.path === list[0].href, after.path + ' vs ' + list[0].href);
  pass('标题与条目一致', !!after.title && list[0].title.indexOf(after.title.slice(0, 6)) >= 0, after.title + ' / ' + list[0].title);

  // 关闭后再点第二条（独立验证不是靠首次渲染的残留状态）
  await evalJs(`document.getElementById('rback').click()`);
  await sleep(400);
  const second = list[1] ? await (async () => {
    await evalJs(`document.querySelectorAll('#recentList a')[1].click()`);
    await sleep(700);
    return evalJs(`(() => { const r = document.getElementById('reader'); return { open: !!r && !r.hidden, path: location.pathname }; })()`);
  })() : null;
  if (second) {
    pass('第二条也能打开并换地址', second.open && second.path === list[1].href, JSON.stringify(second));
  } else {
    pass('第二条也能打开并换地址（跳过：只有 1 篇）', true, 'skip');
  }
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过');
process.exit(bad ? 1 : 0);
