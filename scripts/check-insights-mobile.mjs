import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.SHOT_DIR || 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, height, mobile) {
  const port = 9000 + Math.floor(Math.random() * 300);
  const udd = path.join(os.tmpdir(), 'cr-ins-' + width + '-' + Date.now());
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
  const btn = document.getElementById('insightBtn');
  const box = document.getElementById('insights');
  const list = document.getElementById('list');
  const b = btn.getBoundingClientRect();
  return JSON.stringify({
    btnVisible: b.height > 4,
    btnText: (btn.textContent || '').trim(),
    aria: btn.getAttribute('aria-expanded'),
    boxHidden: box.hidden,
    listTop: Math.round(list.getBoundingClientRect().top),
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth
  });
})()`));

push(m.btnVisible, '手机上出现「分析」按钮', m.btnText);
push(/分析/.test(m.btnText), '按钮文案说清里面是什么', m.btnText);
push(m.aria === 'false', '默认 aria-expanded=false', 'aria=' + m.aria);
push(m.boxHidden === true, '默认收起（不再挡在榜单前面/后面）', 'hidden=' + m.boxHidden);
push(m.sw === m.cw, '手机端不横向溢出', m.sw + '/' + m.cw);
await s.shot('home-insights-folded-390.png', 844);

const opened = JSON.parse(await s.evalJs(`(() => {
  document.getElementById('insightBtn').click();
  const box = document.getElementById('insights');
  const list = document.getElementById('list');
  const r = box.getBoundingClientRect();
  const lr = list.getBoundingClientRect();
  return JSON.stringify({
    hidden: box.hidden,
    aria: document.getElementById('insightBtn').getAttribute('aria-expanded'),
    top: Math.round(r.top),
    listTop: Math.round(lr.top),
    h: Math.round(r.height),
    above: r.top < lr.top
  });
})()`));
push(opened.hidden === false && opened.aria === 'true', '点开后展开且 aria 同步', JSON.stringify([opened.hidden, opened.aria]));
push(opened.above === true, '展开后出现在榜单上面（不是列表末尾）', opened.top + ' < ' + opened.listTop);
push(opened.top <= 900, '展开后不用滚就能看到', 'top=' + opened.top);
push(opened.h > 100, '展开后有内容高度', 'h=' + opened.h);
await sleep(300);
await s.shot('home-insights-open-390.png', 1400);

const closed = JSON.parse(await s.evalJs(`(() => {
  document.getElementById('insightBtn').click();
  return JSON.stringify({ hidden: document.getElementById('insights').hidden, aria: document.getElementById('insightBtn').getAttribute('aria-expanded') });
})()`));
push(closed.hidden === true && closed.aria === 'false', '再点一次收起', JSON.stringify(closed));
s.close();

const w = await session(1440, 900, false);
await w.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);
const wide = JSON.parse(await w.evalJs(`(() => {
  const btn = document.getElementById('insightBtn');
  const box = document.getElementById('insights');
  const list = document.getElementById('list');
  const b = box.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  return JSON.stringify({
    btnDisplay: getComputedStyle(btn).display,
    hidden: box.hidden,
    boxLeft: Math.round(b.left),
    listLeft: Math.round(l.left),
    boxTop: Math.round(b.top),
    listTop: Math.round(l.top),
    mainTop: Math.round(document.querySelector('.main').getBoundingClientRect().top)
  });
})()`));
push(wide.btnDisplay === 'none', '桌面不显示「分析」按钮', wide.btnDisplay);
push(wide.hidden === false, '桌面侧栏照常显示', 'hidden=' + wide.hidden);
push(wide.boxLeft > wide.listLeft + 100, '桌面仍是右侧栏（在榜单右边）', wide.boxLeft + ' > ' + wide.listLeft);
push(Math.abs(wide.boxTop - wide.mainTop) <= 20, '桌面侧栏与主内容列同高起（不是与列表卡对齐）', wide.boxTop + ' ≈ ' + wide.mainTop);
await w.shot('home-insights-1440.png', 900);
w.close();

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
