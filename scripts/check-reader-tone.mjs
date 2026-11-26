import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.SHOT_DIR || 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, height, mobile) {
  const port = 9500 + Math.floor(Math.random() * 200);
  const udd = path.join(os.tmpdir(), 'cr-rt-' + width + '-' + Date.now());
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

// ---------- 390 ----------
let s = await session(390, 844, true);
await s.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);

const m = JSON.parse(await s.evalJs(`(() => {
  const row = document.querySelector('.toolrow');
  const btns = [...row.querySelectorAll('button')].filter(b => b.getBoundingClientRect().height > 4);
  const note = document.getElementById('srcNote');
  const fresh = document.getElementById('freshness');
  const st = getComputedStyle(note);
  return JSON.stringify({
    btnIds: btns.map(b => b.id),
    btnCount: btns.length,
    exportInRow: !!row.querySelector('#btnExport'),
    noteText: (note.textContent || '').trim(),
    noteDisplay: st.display,
    freshText: (fresh.textContent || '').trim(),
    freshTitle: fresh.getAttribute('title') || '',
    listTop: Math.round(document.getElementById('list').getBoundingClientRect().top),
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth
  });
})()`));

push(m.btnCount === 2 && m.btnIds.join(',') === 'btnFavFilter,btnRefresh', '工具栏只留「只看收藏 / 立即刷新」', m.btnIds.join(','));
push(!m.exportInRow, '导出类按钮已从榜单工具栏移走');
push(m.noteText === '', '技术味的「当前数据：…」整段消失', JSON.stringify(m.noteText));
push(m.noteDisplay === 'none', '空的数据来源提示不占位置', m.noteDisplay);
push(/^数据更新于 /.test(m.freshText), '只保留一句「数据更新于 X」', m.freshText);
push(!m.freshText.includes('每 3 小时'), '抓取节奏不再堆在正文里');
push(m.freshTitle === '每 3 小时自动抓取一次', '节奏放进 title 悬停说明', m.freshTitle);
push(m.listTop <= 780, '榜单比上一轮更早出现（801 → 目标 ≤780）', 'listTop=' + m.listTop);
push(m.sw === m.cw, '手机端不横向溢出', m.sw + '/' + m.cw);
await s.shot('home-reader-tone-390.png', 844);

// 设置里能找到数据按钮
const st2 = JSON.parse(await s.evalJs(`(() => {
  document.getElementById('btnSettings').click();
  const vis = (id) => { const el = document.getElementById(id); if (!el) return false; const r = el.getBoundingClientRect(); return r.height > 4; };
  return JSON.stringify({ a: vis('btnFavExport'), b: vis('btnFavImport'), c: vis('btnExport'), settings: !document.getElementById('settings').hidden });
})()`));
push(st2.settings && st2.a && st2.b && st2.c, '「设置」里有导出收藏 / 导入收藏 / 导出 CSV', JSON.stringify(st2));
await sleep(250);
await s.shot('home-settings-data-390.png', 1200);
s.close();

// ---------- 1440 ----------
s = await session(1440, 900, false);
await s.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);
const w = JSON.parse(await s.evalJs(`JSON.stringify({
  listTop: Math.round(document.getElementById('list').getBoundingClientRect().top),
  noteText: (document.getElementById('srcNote').textContent || '').trim(),
  btnCount: [...document.querySelectorAll('.toolrow button')].filter(b => b.getBoundingClientRect().height > 4).length
})`));
push(w.btnCount === 2, '桌面工具栏也只有两个按钮', 'count=' + w.btnCount);
push(w.noteText === '', '桌面同样没有技术味长句');
push(w.listTop <= 470, '桌面榜单更早出现（481 → 目标 ≤470）', 'listTop=' + w.listTop);
await s.shot('home-reader-tone-1440.png', 900);
s.close();

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
