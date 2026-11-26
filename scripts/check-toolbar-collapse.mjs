import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.SHOT_DIR || 'docs/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, height, mobile) {
  const port = 9800 + Math.floor(Math.random() * 150);
  const udd = path.join(os.tmpdir(), 'cr-gate-' + width + '-' + Date.now());
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
    const h = clipH || height;
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64'));
  };
  return { send, evalJs, shot, close: () => { ws.close(); child.kill(); } };
}

const rows = [];
const push = (ok, name, extra = '') => rows.push({ ok: !!ok, name, extra });

// ---------- 390：收起态 ----------
let s = await session(390, 844, true);
await s.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);

const narrow = JSON.parse(await s.evalJs(`(() => {
  const bar = document.querySelector('#rankBar');
  const tog = document.getElementById('mfToggle');
  const body = document.getElementById('mfBody');
  const sel = [...body.querySelectorAll('select')];
  const cats = document.getElementById('cats');
  const cs = getComputedStyle(cats);
  const vis = sel.filter(x => x.getBoundingClientRect().height > 4);
  return JSON.stringify({
    hasToggle: !!tog,
    aria: tog.getAttribute('aria-expanded'),
    togW: Math.round(tog.getBoundingClientRect().width),
    togH: Math.round(tog.getBoundingClientRect().height),
    bodyH: Math.round(body.getBoundingClientRect().height),
    visibleSelects: vis.length,
    qW: Math.round(document.getElementById('q').getBoundingClientRect().width),
    barH: Math.round(bar.getBoundingClientRect().height),
    catsH: Math.round(cats.getBoundingClientRect().height),
    catsWrap: cs.flexWrap,
    mask: (cs.maskImage || cs.webkitMaskImage || ''),
    listTop: Math.round(document.getElementById('list').getBoundingClientRect().top),
    rows: (() => { const t = new Set(); [...bar.querySelector('.controls').children].forEach(el => { const h = el.getBoundingClientRect().height; if (h > 2) t.add(Math.round(el.getBoundingClientRect().top / 10)); }); return t.size; })()
  });
})()`));

push(narrow.hasToggle, '窄屏有「筛选」按钮');
push(narrow.aria === 'false', '默认 aria-expanded=false', 'aria=' + narrow.aria);
push(narrow.togW >= 60 && narrow.togH >= 38, '筛选按钮尺寸可点', 'w' + narrow.togW + ' h' + narrow.togH);
push(narrow.visibleSelects === 0 && narrow.bodyH <= 2, '收起时三个下拉都不可见', 'visible=' + narrow.visibleSelects + ' h=' + narrow.bodyH);
push(narrow.qW > 200, '搜索框仍独占一行', 'w=' + narrow.qW);
push(narrow.rows <= 4, '控件行数 ≤4', 'rows=' + narrow.rows);
push(narrow.barH <= 260, '工具区高度 ≤260（原来 374）', 'h=' + narrow.barH);
push(narrow.catsWrap === 'nowrap', '分类胶囊单行不换行', 'wrap=' + narrow.catsWrap);
push(narrow.catsH <= 48, '分类区高度 ≤48（原来 132）', 'h=' + narrow.catsH);
push(/linear-gradient/.test(narrow.mask), '分类区有右缘渐隐', narrow.mask.slice(0, 36));
push(narrow.listTop <= 1000, '首屏更早看到榜单', 'listTop=' + narrow.listTop);
await s.shot('home-toolbar-390.png', 844);

// ---------- 390：展开态 + 角标 ----------
const opened = JSON.parse(await s.evalJs(`(() => {
  const tog = document.getElementById('mfToggle');
  tog.click();
  const body = document.getElementById('mfBody');
  const sel = [...body.querySelectorAll('select')];
  const vis = sel.filter(x => x.getBoundingClientRect().height > 4);
  const sort = document.getElementById('sort');
  sort.value = 'trend';
  sort.dispatchEvent(new Event('change', { bubbles: true }));
  const badge = document.getElementById('mfN').textContent.trim();
  const barR = document.querySelector('#rankBar').getBoundingClientRect().right;
  const over = sel.filter(x => x.getBoundingClientRect().right > barR + 1).length;
  const rowTops = new Set(sel.map(x => Math.round(x.getBoundingClientRect().top / 10))).size;
  let docSame = null;
  try { docSame = document.documentElement.dataset.probe || 'n/a'; } catch (e) { docSame = 'err'; }
  return JSON.stringify({
    aria: tog.getAttribute('aria-expanded'),
    visibleSelects: vis.length,
    widths: vis.map(x => Math.round(x.getBoundingClientRect().width)),
    badge,
    over,
    rowTops,
    docSame
  });
})()`));
push(opened.aria === 'true', '点开后 aria-expanded=true', 'aria=' + opened.aria);
push(opened.visibleSelects === 3, '展开后三个下拉都可见', 'visible=' + opened.visibleSelects);
push(opened.widths.every((w) => w >= 90), '展开后下拉有可用宽度', opened.widths.join('/'));
push(opened.over === 0, '展开后下拉不溢出卡片（原来第三个被切）', 'over=' + opened.over);
push(opened.rowTops <= 2, '展开后下拉最多两行', 'rows=' + opened.rowTops);
push(opened.badge === '· 1', '改了排序后角标显示非默认项数', 'badge=' + opened.badge);
await sleep(300);
await s.shot('home-toolbar-390-open.png', 900);
await s.evalJs(`(() => { const s2 = document.getElementById('sort'); s2.value = 'stars'; s2.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('mfToggle').click(); return 1; })()`);
push(true, '再次点击可收起（不报错）');
s.close();

// ---------- 1440：桌面不受影响 ----------
s = await session(1440, 900, false);
await s.send('Page.navigate', { url: 'http://127.0.0.1:8123/' });
await sleep(3200);
const wide = JSON.parse(await s.evalJs(`(() => {
  const body = document.getElementById('mfBody');
  const tog = document.getElementById('mfToggle');
  const sel = [...body.querySelectorAll('select')];
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  return JSON.stringify({
    bodyDisplay: getComputedStyle(body).display,
    togDisplay: getComputedStyle(tog).display,
    selVisible: sel.filter(x => x.getBoundingClientRect().height > 4).length,
    selBoxes: sel.map(box),
    qBox: box(document.getElementById('q')),
    catsWrap: getComputedStyle(document.getElementById('cats')).flexWrap
  });
})()`));
push(wide.bodyDisplay === 'contents', '桌面面板用 display:contents 不占布局', wide.bodyDisplay);
push(wide.togDisplay === 'none', '桌面不显示「筛选」按钮', wide.togDisplay);
push(wide.selVisible === 3, '桌面三个下拉直接可见', 'visible=' + wide.selVisible);
const sameRow = wide.selBoxes.every((b) => Math.abs(b.y - wide.selBoxes[0].y) <= 2);
push(sameRow, '桌面上三个下拉在同一行（不再竖排）', wide.selBoxes.map((b) => b.x + ',' + b.y).join(' | '));
push(wide.selBoxes.every((b) => b.w >= 80), '桌面下拉有正常宽度', wide.selBoxes.map((b) => b.w).join('/'));
const noOverlap = !wide.selBoxes.some((b) => !(b.x + b.w <= wide.qBox.x - 4 || b.x >= wide.qBox.x + wide.qBox.w + 4));
push(noOverlap && wide.selBoxes.every((b) => Math.abs(b.y - wide.qBox.y) <= 2), '桌面下拉与搜索框同排且不重叠', 'q=' + wide.qBox.x + ',' + wide.qBox.y);
push(wide.catsWrap === 'wrap', '桌面分类仍换行排列', wide.catsWrap);
await s.shot('home-toolbar-1440.png', 900);
s.close();

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
