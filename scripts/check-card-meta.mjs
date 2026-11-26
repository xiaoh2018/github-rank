import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.SHOT_DIR || 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, height, mobile, touch) {
  const port = 9800 + Math.floor(Math.random() * 190);
  const udd = path.join(os.tmpdir(), 'cr-cm-' + width + '-' + Date.now());
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
  const card = document.querySelector('#list .item:not(.ad-inline)');
  const meta = card.querySelector('.meta');
  const spans = Array.prototype.slice.call(meta.querySelectorAll(':scope > span'));
  const lines = Array.from(new Set(spans.map(function (s) { return Math.round(s.getBoundingClientRect().top); })));
  const minis = Array.prototype.slice.call(meta.querySelectorAll('.mini'));
  const mr = meta.getBoundingClientRect();
  return JSON.stringify({
    text: meta.textContent.replace(/\\s+/g, ' ').trim(),
    spanCount: spans.length,
    lines: lines.length,
    h: Math.round(mr.height),
    miniVisible: minis.some(function (b) { return getComputedStyle(b).display !== 'none'; }),
    hoverNone: window.matchMedia('(hover:none)').matches
  });
})()`;

const s = await session(390, 844, true, true);
await s.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);
const d = JSON.parse(await s.evalJs(READ));
push(d.miniVisible === false, '手机上没有「复制 / 卡片」按钮（站长工具）', 'hoverNone=' + d.hoverNone);
push(!/Fork/.test(d.text), '默认不显示 Fork 数', d.text);
push(/活跃度/.test(d.text) && /更新/.test(d.text), '保留「活跃度」和「多久前更新」', '');
push(d.lines <= 2, '信息行最多两行（不再被按钮挤成三行）', 'lines=' + d.lines + ' h=' + d.h);
push(d.h <= 52, '信息行高度回到两行内', 'h=' + d.h);
const ov = JSON.parse(await s.evalJs(`JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})`));
push(ov.sw === ov.cw, '手机端不溢出', ov.sw + '/' + ov.cw);
await s.shot('home-card-meta-390.png', 900);

await s.evalJs(`(() => { const sel = document.getElementById('sort'); sel.value = 'forks'; sel.dispatchEvent(new Event('change', { bubbles: true })); return '1'; })()`);
await sleep(1600);
const f = JSON.parse(await s.evalJs(READ));
push(/Fork/.test(f.text), '按 Fork 排序时才显示 Fork 数（可核对）', f.text);
push(f.lines <= 2, '排序切换后仍然最多两行', 'lines=' + f.lines + ' h=' + f.h);
await s.shot('home-card-meta-forks-390.png', 900);
s.close();

const w = await session(1440, 900, false, false);
await w.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);
const wide = JSON.parse(await w.evalJs(READ));
push(wide.lines === 1, '桌面信息行仍是单行', 'lines=' + wide.lines + ' h=' + wide.h);
push(wide.miniVisible === true, '桌面上鼠标悬停用的「复制 / 卡片」按钮还在（未误伤）', '');
w.close();

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
