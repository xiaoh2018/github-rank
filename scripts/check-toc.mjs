// 「本文目录」展开策略门禁：宽屏默认展开、窄屏默认收起、点一下能展开。
// 用法：先起 dev-server（8123），再 node scripts/check-toc.mjs [--shot 输出png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shotArg = process.argv.indexOf('--shot');
const shotOut = shotArg > -1 ? process.argv[shotArg + 1] : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  [' + (d == null ? '' : d) + ']')); if (!c) fails++; };

const body = ['## 第一节 数据来源', '正文一', '## 第二节 排序口径', '正文二', '## 第三节 缓存策略', '正文三', '## 第四节 常见问题', '正文四'].join('\n\n');
const addRes = await fetch(base + '/api/articles', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PW, action: 'add', article: { title: '__toc__目录折叠门禁', category: '随笔', summary: '门禁用，跑完删除', body } }),
});
const addJson = await addRes.json().catch(() => ({}));
const list = Array.isArray(addJson.articles) ? addJson.articles : [];
const mine = list.filter((a) => a.title === '__toc__目录折叠门禁').pop();
if (!mine) { console.error('造文章失败：' + JSON.stringify(addJson).slice(0, 200)); process.exit(1); }
const url = base + '/articles/' + String(mine.slug).split('/').map(encodeURIComponent).join('/') + '.html';

const port = 9900 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-toc-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 40 && !target; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const readToc = `(() => { const t=document.getElementById('rToc'); if(!t) return null; return { hidden:t.hidden, open:t.open, items:t.querySelectorAll('ol li').length, summary:t.querySelector('summary')?t.querySelector('summary').textContent.trim():'' }; })()`;

try {
  await send('Page.enable'); await send('Runtime.enable');

  console.log('== 1. 宽屏 1440：默认展开 ==');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: url + '?v=' + Date.now() });
  await sleep(2600);
  const wide = await evalJs(readToc);
  ok('目录存在且可见', wide && wide.hidden === false, JSON.stringify(wide));
  ok('宽屏默认展开', wide && wide.open === true, wide && wide.open);
  ok('条目 ≥ 3', wide && wide.items >= 3, wide && wide.items);
  ok('标题是「本文目录」', wide && /本文目录/.test(wide.summary || ''), wide && wide.summary);

  console.log('== 2. 窄屏 390：默认收起 ==');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: url + '?v=' + Date.now() + 'm' });
  await sleep(2600);
  const narrow = await evalJs(readToc);
  ok('窄屏目录仍在（只是收起）', narrow && narrow.hidden === false, JSON.stringify(narrow));
  ok('窄屏默认收起', narrow && narrow.open === false, narrow && narrow.open);

  console.log('== 3. 窄屏点一下能展开 ==');
  const clicked = await evalJs(`(() => { const t=document.getElementById('rToc'); const s=t.querySelector('summary'); s.click(); return new Promise(res=>setTimeout(()=>res({ open:t.open, items:t.querySelectorAll('ol li').length, touched:t.dataset.touched }), 260)); })()`);
  ok('点开后 open=true', clicked && clicked.open === true, clicked && clicked.open);
  ok('点开后条目 ≥ 3', clicked && clicked.items >= 3, clicked && clicked.items);
  ok('记住用户动过（touched）', clicked && clicked.touched === '1', clicked && clicked.touched);

  console.log('== 4. 打印前自动展开、打印后恢复 ==');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: url + '?v=' + Date.now() + 'p' });
  await sleep(2500);
  const printFlow = await evalJs(`(() => {
    const t = document.getElementById('rToc');
    const before = t.open;
    window.dispatchEvent(new Event('beforeprint'));
    const during = t.open;
    window.dispatchEvent(new Event('afterprint'));
    return { before, during, after: t.open };
  })()`);
  ok('窄屏起始是收起的', printFlow && printFlow.before === false, JSON.stringify(printFlow));
  ok('beforeprint 后目录展开', printFlow && printFlow.during === true, printFlow && printFlow.during);
  ok('afterprint 后恢复收起', printFlow && printFlow.after === false, printFlow && printFlow.after);

  if (shotOut) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: url + '?v=' + Date.now() + 's' });
    await sleep(2600);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(shotOut, Buffer.from(shot.result.data, 'base64'));
    console.log('saved ' + shotOut + ' ' + fs.statSync(shotOut).size + 'B');
  }
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  const del = await fetch(base + '/api/articles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW, action: 'remove', id: mine.id }) });
  const dj = await del.json().catch(() => ({}));
  const rest = (Array.isArray(dj.articles) ? dj.articles : []).filter((a) => a.title === '__toc__目录折叠门禁').length;
  console.log('清理：' + (del.ok ? 'ok' : 'HTTP ' + del.status) + '，残留 ' + rest);
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
