import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.SHOT_DIR || 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, height, mobile) {
  const port = 9200 + Math.floor(Math.random() * 200);
  const udd = path.join(os.tmpdir(), 'cr-set-' + width + '-' + Date.now());
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
  document.getElementById('btnSettings').click();
  const panel = document.getElementById('settings');
  const cards = [...panel.querySelectorAll(':scope > .card')];
  const first = cards[0] ? cards[0].id : '';
  const theme = document.getElementById('themeRow');
  const tokenCard = document.getElementById('tokenCard');
  const tok = document.getElementById('token');
  const guide = panel.querySelector('details.guide');
  const ol = guide ? guide.querySelector('ol') : null;
  const txt = panel.innerText || '';
  const count = (w) => (txt.split(w).length - 1);
  return JSON.stringify({
    first,
    cardIds: cards.map(c => c.id || c.className),
    themeTop: theme ? Math.round(theme.getBoundingClientRect().top) : -1,
    tokenTop: tokenCard ? Math.round(tokenCard.getBoundingClientRect().top) : -1,
    tokVisible: tok ? tok.getBoundingClientRect().height > 4 : false,
    saveVisible: document.getElementById('btnSaveToken').getBoundingClientRect().height > 4,
    clearVisible: document.getElementById('btnClearToken').getBoundingClientRect().height > 4,
    guideOpen: guide ? guide.open : null,
    olH: ol ? Math.round(ol.getBoundingClientRect().height) : -1,
    guideH: guide ? Math.round(guide.getBoundingClientRect().height) : -1,
    upCount: count('上传'),
    threeHour: count('3 小时'),
    themeChips: panel.querySelectorAll('[data-theme-pick]').length,
    gap: (() => { const a = document.getElementById('themeRow').getBoundingClientRect(); const b = document.getElementById('tokenCard').getBoundingClientRect(); return Math.round(b.top - a.bottom); })(),
    tokenPh: document.getElementById('token').placeholder,
    cardBorder: getComputedStyle(document.getElementById('themeRow')).borderTopWidth,
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth
  });
})()`));

push(m.first === 'themeRow', '设置面板第一块是「配色主题」', 'first=' + m.first);
push(m.themeTop < m.tokenTop, '主题在 Token 之前（先给最常改的）', m.themeTop + ' < ' + m.tokenTop);
push(m.tokVisible && m.saveVisible && m.clearVisible, 'Token 输入框与保存/清除都在', JSON.stringify([m.tokVisible, m.saveVisible, m.clearVisible]));
push(m.themeChips === 4, '四套主题都在', 'chips=' + m.themeChips);
push(m.guideOpen === false, '教程默认收起（不再一屏六步）', 'open=' + m.guideOpen);
push(m.guideH > 0 && m.guideH <= 64, '收起时只露标题行（details 高度≈标题）', 'detailsH=' + m.guideH);
push(m.upCount === 1, '「上传」只说一次（去重）', 'count=' + m.upCount);
push(m.threeHour <= 1, '「3 小时」只说一次', 'count=' + m.threeHour);
push(m.gap >= 8, '两块卡片之间有间距（不再糊成一大块）', 'gap=' + m.gap);
push(m.cardBorder !== '0px', '每块卡片有可见边框', m.cardBorder);
push(/ghp_/.test(m.tokenPh) && m.tokenPh.length <= 24, 'Token 输入框提示短且说清要粘什么', m.tokenPh);
push(m.sw === m.cw, '手机端不横向溢出', m.sw + '/' + m.cw);

const opened = JSON.parse(await s.evalJs(`(() => {
  const g = document.querySelector('#settings details.guide');
  g.querySelector('summary').click();
  const ol = g.querySelector('ol');
  return JSON.stringify({ open: g.open, h: Math.round(g.getBoundingClientRect().height), li: ol.querySelectorAll('li').length });
})()`));
push(opened.open === true && opened.h > 200, '点开教程能展开（details 高度≥200）', JSON.stringify(opened));
push(opened.li === 6, '教程仍是 6 步', 'li=' + opened.li);

await s.evalJs(`(() => { document.querySelector('#settings details.guide summary').click(); window.scrollTo(0, 0); return 1; })()`);
await sleep(300);
await s.shot('home-settings-390.png', 1400);
s.close();

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
