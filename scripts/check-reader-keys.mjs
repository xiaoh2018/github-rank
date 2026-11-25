// 阅读器键盘门禁：End 到底、Home 回顶、Esc 关闭；并检查 /articles 与 /faq 的 RSS 入口。
// 用法：先起 dev-server（8123），再 node scripts/check-reader-keys.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 10090 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-keys-'));
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
const key = (k) => evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
const open = async (p) => { await send('Page.navigate', { url: base + p + '?v=' + Date.now() }); await sleep(2400); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 620, deviceScaleFactor: 1, mobile: false });

console.log('== 阅读器键盘 ==');
await open('/articles');
const opened = await evalJs(`(() => { var c = document.querySelector('#cards .acard'); if (!c) return { ok: false }; c.click(); return { ok: true }; })()`);
await sleep(1200);
const vis = await evalJs(`(() => { var r = document.getElementById('reader'); return r ? !r.hidden : false; })()`);
ok('点卡片能打开阅读器', opened && opened.ok && vis === true, JSON.stringify({ opened, vis }));
const bar0 = await evalJs(`(() => { var b = document.getElementById('rprogress'); return b ? { hidden: b.hidden, w: parseFloat(b.style.width) || 0 } : null; })()`);
ok('阅读器打开后进度条出现', bar0 && bar0.hidden === false, JSON.stringify(bar0));

await evalJs(`window.scrollTo(0, 0)`);
await sleep(300);
await key('End');
await sleep(1400);
const endY = await evalJs(`Math.round(window.scrollY)`);
ok('按 End 跳到正文末尾', typeof endY === 'number' && endY > 150, String(endY));
const barEnd = await evalJs(`(() => { var b = document.getElementById('rprogress'); return b ? parseFloat(b.style.width) || 0 : -1; })()`);
ok('按 End 后进度条前进', typeof barEnd === 'number' && barEnd > 30, String(barEnd));

await key('Home');
await sleep(1400);
const homeY = await evalJs(`Math.round(window.scrollY)`);
ok('按 Home 回到顶部', typeof homeY === 'number' && homeY < 120, String(homeY));

await key('Escape');
await sleep(700);
const closed = await evalJs(`(() => { var r = document.getElementById('reader'); return r ? r.hidden : true; })()`);
ok('按 Esc 关闭阅读器', closed === true, String(closed));
const barOff = await evalJs(`(() => { var b = document.getElementById('rprogress'); return b ? b.hidden : null; })()`);
ok('关闭阅读器后进度条隐藏', barOff === true, String(barOff));

console.log('== 榜单卡片键盘焦点 ==');
await open('/');
const focus = await evalJs(`(() => {
  var a = document.querySelector('#list .item .name');
  if (!a) return { ok: false };
  a.focus();
  var item = a.closest('.item');
  var cs = getComputedStyle(item);
  return { ok: true, focused: document.activeElement === a, shadow: cs.boxShadow };
})()`);
ok('榜单卡片里的链接可聚焦', focus && focus.ok && focus.focused === true, JSON.stringify(focus));
ok('聚焦时整张卡有高亮（focus-within）', focus && typeof focus.shadow === 'string' && focus.shadow !== 'none', JSON.stringify(focus));

console.log('== RSS 入口 ==');
const artHtml = await (await fetch(base + '/articles?v=' + Date.now())).text();
ok('/articles 页脚有 RSS 订阅', artHtml.indexOf('href="/rss.xml"') >= 0, '');
ok('/articles 页脚有站点地图', artHtml.indexOf('href="/sitemap.xml"') >= 0, '');
const faqHtml = await (await fetch(base + '/faq?v=' + Date.now())).text();
ok('/faq 页脚有 RSS', faqHtml.indexOf('href="/rss.xml"') >= 0, '');
const rss = await fetch(base + '/rss.xml?v=' + Date.now());
const rssText = await rss.text().catch(() => '');
ok('/rss.xml 可访问且是 RSS 2.0', rss.ok && rssText.indexOf('<rss version="2.0"') >= 0, 'status=' + rss.status);

console.log(fails ? '\n' + fails + ' FAILED' : '\n全部通过');
try { ws.close(); } catch {}
try { child.kill(); } catch {}
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
