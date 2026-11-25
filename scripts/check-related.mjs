// 「相关阅读」门禁：/articles 点第一张卡片 → 阅读器底部出现 1~3 条相关阅读，
// 链接都是本站 /articles/… 规范地址，且不含当前这篇。
// 用法：先起 dev-server（8123），再 node scripts/check-related.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.env.URL || 'http://127.0.0.1:8123/articles';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9500 + Math.floor(Math.random() * 300);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-rel-'));
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
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(2600);

const cardCount = await evalJs(`document.querySelectorAll('#cards .acard').length`);
ok('文章列表有卡片', cardCount > 0, 'cards=' + cardCount);
if (!cardCount) { try { await send('Browser.close'); } catch {} child.kill(); process.exit(1); }

await evalJs(`(() => { const c = document.querySelector('#cards .acard'); c.click(); return 1; })()`);
await sleep(1500);

const info = await evalJs(`(() => {
  const box = document.querySelector('.related');
  if (!box) return { found: false };
  const links = [...box.querySelectorAll('a')].map(a => a.getAttribute('href') || '');
  return {
    found: true,
    h2: (box.querySelector('h2') || {}).textContent || '',
    n: links.length,
    links,
    selfTitle: (document.querySelector('#rTitle') || {}).textContent || '',
    titles: [...box.querySelectorAll('a')].map(a => a.textContent.trim()),
  };
})()`);

ok('阅读器里有「相关阅读」', !!info.found, JSON.stringify(info).slice(0, 120));
if (info.found) {
  ok('标题是相关阅读', info.h2.trim() === '相关阅读', info.h2);
  ok('条数 1~3', info.n >= 1 && info.n <= 3, 'n=' + info.n);
  ok('链接都是本站 /articles/ 规范地址', info.links.every((h) => h.indexOf('/articles/') === 0 && h.endsWith('.html')), info.links.join(','));
  ok('不含当前这篇', !info.titles.some((t) => t === info.selfTitle.trim()), info.selfTitle + ' / ' + info.titles.join(' | '));
}

// 关闭再开另一篇，确认仍能渲染（防 state 残留）
await evalJs(`(() => { const b = document.querySelector('#rback'); if (b) b.click(); return 1; })()`);
await sleep(700);
await evalJs(`(() => { const c = document.querySelectorAll('#cards .acard')[1]; if (c) c.click(); return 1; })()`);
await sleep(1200);
const again = await evalJs(`document.querySelectorAll('.related li').length`);
ok('换一篇仍有相关阅读', again >= 1, 'n=' + again);

console.log(fails ? `相关阅读门禁 ${fails} 项失败` : '相关阅读门禁全部通过');
try { await send('Browser.close'); } catch {}
child.kill();
process.exit(fails ? 1 : 0);
