import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.SHOT_DIR || 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, height, mobile) {
  const port = 9200 + Math.floor(Math.random() * 300);
  const udd = path.join(os.tmpdir(), 'cr-fn-' + width + '-' + Date.now());
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, '--window-size=' + width + ',' + height, 'about:blank'], { stdio: 'ignore' });
  let url = null;
  for (let i = 0; i < 60 && !url; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      const page = list.find((x) => x.type === 'page');
      if (page) url = page.webSocketDebuggerUrl;
    } catch {}
    if (!url) await sleep(300);
  }
  if (!url) throw new Error('no cdp');
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((res) => { const my = ++id; waiting.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: !!mobile });
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

const s = await session(390, 844, true);
await s.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);

const m = JSON.parse(await s.evalJs(`(() => {
  const p = document.querySelector('.main > p.note:last-of-type');
  const btn = document.getElementById('aboutMore');
  const box = p ? p.getBoundingClientRect() : null;
  const b = btn ? btn.getBoundingClientRect() : null;
  return JSON.stringify({
    text: p ? p.textContent.replace(/\\s+/g, ' ').trim() : '',
    btnVisible: b ? (b.height > 10 && b.top >= box.top - 2 && b.bottom <= box.bottom + 2) : false,
    boxH: box ? Math.round(box.height) : 0,
    dialogOpenBefore: document.getElementById('aboutDialog').open,
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth
  });
})()`));

push(/数据取自 GitHub/.test(m.text), '底部说明用一句话说清数据从哪来', m.text.slice(0, 30));
push(!/Search API|分段|分页查询|缓存 2 小时/.test(m.text), '底部不再出现实现细节', '');
push(/每 3 小时/.test(m.text) && /前 500 个/.test(m.text), '保留了「多久更新」「取多少个」两个关键数字', '');
push(/分享/.test(m.text), '说清链接可分享', '');
push(m.text.length <= 90, '整句不超过 90 字', 'len=' + m.text.length);
push(m.btnVisible, '「数据怎么来的」按钮在说明行内', 'h=' + m.boxH);
push(m.dialogOpenBefore === false, '进页面时关于弹窗是关的', 'open=' + m.dialogOpenBefore);
push(m.sw === m.cw, '手机端不溢出', m.sw + '/' + m.cw);
await s.shot('home-footnote-390.png', 844);

const opened = JSON.parse(await s.evalJs(`(() => {
  document.getElementById('aboutMore').click();
  const d = document.getElementById('aboutDialog');
  const t = d.querySelector('details.technote');
  const sum = t ? t.querySelector('summary') : null;
  const ps = t ? Array.prototype.slice.call(t.querySelectorAll('p')) : [];
  return JSON.stringify({
    open: d.open,
    hasTechnote: !!t,
    folded: t ? t.open : null,
    summary: sum ? sum.textContent.trim() : '',
    body: ps.map(function (x) { return x.textContent.trim(); }).join('  ')
  });
})()`));
push(opened.open === true, '点按钮能打开「关于本站」', 'open=' + opened.open);
push(opened.hasTechnote === true, '技术细节搬进弹窗里的折叠块', '');
push(/技术细节/.test(opened.summary), '折叠块标题说清是技术细节', opened.summary);
push(opened.folded === false, '默认收起（不喧宾夺主）', 'open=' + opened.folded);
push(/抓取规则/.test(opened.body) && /500/.test(opened.body) && /口径/.test(opened.body), '技术细节仍在（抓取规则 + 口径）', opened.body.slice(0, 24));
await sleep(300);
await s.shot('home-about-technote-390.png', 900);

const closed = JSON.parse(await s.evalJs(`(() => {
  const d = document.getElementById('aboutDialog');
  d.querySelector('#aboutClose').click();
  return JSON.stringify({ open: d.open });
})()`));
push(closed.open === false, '关闭按钮能关掉', 'open=' + closed.open);
s.close();

const w = await session(1440, 900, false);
await w.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);
const wide = JSON.parse(await w.evalJs(`(() => {
  const p = document.querySelector('.main > p.note:last-of-type');
  const r = p.getBoundingClientRect();
  return JSON.stringify({ h: Math.round(r.height), lines: Math.round(r.height / 22), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth });
})()`));
push(wide.lines <= 2, '桌面只占一行到两行', 'h=' + wide.h + ' ≈ ' + wide.lines + ' 行');
push(wide.sw === wide.cw, '桌面不溢出', wide.sw + '/' + wide.cw);
w.close();

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
