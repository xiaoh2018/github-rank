import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, height, mobile) {
  const port = 9700 + Math.floor(Math.random() * 190);
  const udd = path.join(os.tmpdir(), 'cr-es-' + width + '-' + Date.now());
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, '--window-size=' + width + ',' + height, 'about:blank'], { stdio: 'ignore' });
  let url = null;
  for (let i = 0; i < 60 && !url; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/list'); const l = await r.json(); const p = l.find((x) => x.type === 'page'); if (p) url = p.webSocketDebuggerUrl; } catch {}
    if (!url) await sleep(300);
  }
  if (!url) throw new Error('no cdp');
  const ws = new WebSocket(url);
  let id = 0; const waiting = new Map(); const paused = [];
  let blockOn = true;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else if (m.method === 'Fetch.requestPaused') paused.push(m.params);
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((res) => { const my = ++id; waiting.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: !!mobile });
  const pump = setInterval(async () => {
    while (paused.length) {
      const ev = paused.shift();
      const u = ev.request.url;
      const hit = blockOn && (/\/data\/repos-/.test(u) || /\/data\/repos\.js/.test(u) || /\/api\/gh/.test(u) || /github\.com\//.test(u));
      try {
        if (hit) await send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'Failed' });
        else await send('Fetch.continueRequest', { requestId: ev.requestId });
      } catch {}
    }
  }, 30);
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception));
    return r.result.result.value;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await evalJs(expr)) return true; } catch {}
      await sleep(300);
    }
    return false;
  };
  const shot = async (file, clipH) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: clipH || height, scale: 1 } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64'));
  };
  return { send, evalJs, waitFor, shot, setBlock: (v) => { blockOn = v; }, close: () => { clearInterval(pump); ws.close(); child.kill(); } };
}

const rows = [];
const push = (ok, name, extra = '') => rows.push({ ok: !!ok, name, extra });

const dump = (s) => s.evalJs(`(() => {
  const box = document.querySelector('#list .errbox');
  const btns = box ? Array.prototype.map.call(box.querySelectorAll('button'), function (b) { return b.textContent.trim(); }) : [];
  const st = document.getElementById('status');
  return JSON.stringify({
    hasCard: !!document.querySelector('#list .err-card'),
    title: box ? (box.querySelector('b') || {}).textContent : '',
    why: box ? (box.querySelector('.errwhy') || {}).textContent : '',
    hint: box ? (box.querySelector('.errhint') || {}).textContent : '',
    buttons: btns,
    skeletons: document.querySelectorAll('#list .skel').length,
    status: st ? st.textContent.trim() : '',
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth
  });
})()`);

/* ---------------- 手机 390 ---------------- */
const s = await session(390, 844, true);
await s.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
await s.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
const got = await s.waitFor(`!!document.querySelector('#list .err-card')`, 30000);
const err = JSON.parse(await dump(s));

push(got && err.hasCard, '数据全挂时出现错误卡片（不是空白或永远骨架）', 'card=' + err.hasCard);
push(/没读到数据/.test(err.title || ''), '卡片标题说清发生了什么', err.title);
push(/网络|频繁|出问题|没能/.test(err.why || ''), '原因是人话，不是英文报错', err.why);
push(err.buttons.indexOf('重试') >= 0 && err.buttons.indexOf('稍后再看') >= 0, '给下一步：重试 / 稍后再看', err.buttons.join('/'));
push(/收藏/.test(err.hint || ''), '顺带安抚：本地收藏不受影响', err.hint);
push(err.skeletons === 0, '骨架屏已收走（不留假加载态）', 'skel=' + err.skeletons);
push(err.status === '', '状态行不再挂「加载数据…」', '[' + err.status + ']');
push(err.sw === err.cw, '手机端不溢出', err.sw + '/' + err.cw);
await s.shot('home-error-390.png', 900);

// 恢复网络后点「重试」：错误卡应消失、重新进入加载或直接出数据
s.setBlock(false);
const clicked = await s.evalJs(`(() => {
  const b = Array.prototype.find.call(document.querySelectorAll('#list .errbox button'), function (x) { return x.textContent.trim() === '重试'; });
  if (!b) return 'none';
  b.click(); return 'ok';
})()`);
push(clicked === 'ok', '「重试」按钮可点', clicked);
const recovered = await s.waitFor(`!document.querySelector('#list .err-card')`, 12000);
push(recovered, '点「重试」后错误卡消失（真的重新发起了加载）', '');
await s.shot('home-error-retry-390.png', 900);
s.close();

/* ---------------- 桌面 1440 ---------------- */
const w = await session(1440, 900, false);
await w.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
await w.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
const got2 = await w.waitFor(`!!document.querySelector('#list .err-card')`, 30000);
const wide = JSON.parse(await w.evalJs(`(() => {
  const box = document.querySelector('#list .errbox');
  const r = box ? box.getBoundingClientRect() : null;
  return JSON.stringify({ has: !!box, w: r ? Math.round(r.width) : 0, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth });
})()`));
push(got2 && wide.has, '桌面同样有错误卡片', '');
push(wide.sw === wide.cw, '桌面不溢出', wide.sw + '/' + wide.cw);
await w.shot('home-error-1440.png', 900);
w.close();

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
