import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.SHOT_DIR || 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WANT = ['全部', 'AI 与大模型', '效率工具', 'Web 前端', '开发工具', '安全', '数据与后端', '游戏', '学习资源'];

async function session(width, height, mobile, touch) {
  const port = 9300 + Math.floor(Math.random() * 190);
  const udd = path.join(os.tmpdir(), 'cr-cl-' + width + '-' + Date.now());
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, '--window-size=' + width + ',' + height, 'about:blank'], { stdio: 'ignore' });
  let url = null;
  for (let i = 0; i < 60 && !url; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/list'); const l = await r.json(); const p = l.find((x) => x.type === 'page'); if (p) url = p.webSocketDebuggerUrl; } catch {}
    if (!url) await sleep(300);
  }
  if (!url) throw new Error('no cdp');
  const ws = new WebSocket(url);
  let id = 0; const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((res) => { const my = ++id; waiting.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: !!mobile });
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  const shot = async (file, clipH) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: clipH || height, scale: 1 } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64'));
  };
  return { send, evalJs, shot, close: () => { ws.close(); child.kill(); } };
}

const rows = [];
const push = (ok, name, extra = '') => rows.push({ ok: !!ok, name, extra });

const READ = `(() => {
  const chips = Array.prototype.slice.call(document.querySelectorAll('#cats .cat'));
  return JSON.stringify({
    labels: chips.map(function (c) { return c.textContent.trim(); }),
    pressed: chips.map(function (c) { return c.getAttribute('aria-pressed'); }),
    titles: chips.map(function (c) { return c.title; }),
    types: chips.map(function (c) { return c.getAttribute('type'); }),
    count: (document.getElementById('pageInfo') || {}).textContent || '',
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth
  });
})()`;

const s = await session(390, 844, true, true);
await s.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);
const d = JSON.parse(await s.evalJs(READ));
push(JSON.stringify(d.labels) === JSON.stringify(WANT), '分类名都是大白话（无斜杠、无缩写）', d.labels.join(' | '));
push(d.labels.every((x) => x.indexOf('/') === -1), '一个斜杠都没有', '');
push(d.types.every((t) => t === 'button'), '都是正经 button（不会误触发表单提交）', '');
push(d.titles.slice(1).every((t) => /^只看.+相关的项目/.test(t)), '每个分类都有「只看…相关的项目」提示', d.titles[1]);
push(d.pressed[0] === 'true' && d.pressed.slice(1).every((p) => p === 'false'), '默认只有「全部」是选中态', d.pressed.join(','));
push(d.sw === d.cw, '手机端不溢出', d.sw + '/' + d.cw);
await s.shot('home-cats-390.png', 900);

const after = JSON.parse(await s.evalJs(`(() => {
  const chips = Array.prototype.slice.call(document.querySelectorAll('#cats .cat'));
  const ai = chips.find(function (c) { return c.textContent.trim() === 'AI 与大模型'; });
  ai.click();
  return JSON.stringify({ ok: true });
})()`));
await sleep(1800);
const sel = JSON.parse(await s.evalJs(READ));
push(sel.pressed[1] === 'true' && sel.pressed[0] === 'false', '点分类后选中态同步到 aria-pressed', sel.pressed.join(','));
push(/页/.test(sel.count), '列表跟着筛选刷新了', sel.count);
const url1 = await s.evalJs('location.search');
push(/cat=ai/.test(url1), '筛选条件写进网址（可分享）', url1);
await s.shot('home-cats-ai-390.png', 900);
s.close();

const w = await session(1440, 900, false, false);
await w.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);
const wide = JSON.parse(await w.evalJs(READ));
push(JSON.stringify(wide.labels) === JSON.stringify(WANT), '桌面同一套分类名', wide.labels.join(' | '));
push(wide.sw === wide.cw, '桌面不溢出', wide.sw + '/' + wide.cw);
await w.shot('home-cats-1440.png', 900);
w.close();

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
