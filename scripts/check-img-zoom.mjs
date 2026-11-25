// 门禁：文章配图点击放大（lightbox）＋ Esc 只关灯箱、不误关阅读器
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const pw = process.env.GHRANK_PW || 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const pass = (n, c, e) => { if (c) { ok++; console.log('  PASS  ' + n); } else { bad++; console.log('  FAIL  ' + n + (e ? '  [' + e + ']' : '')); } };

const api = async (p, body) => {
  const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};

const port = 10400 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-img-'));
const child = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let tg;
for (let i = 0; i < 60 && !tg; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); tg = l.find((x) => x.type === 'page'); } catch {}
  if (!tg) await sleep(250);
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let n = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => { const i = ++n; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pend.set(i, r)); };
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description));
  return r.result && r.result.result && r.result.result.value;
}
const key = async (k, code, keyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
};

let artId = '';
const title = '__门禁__配图放大 ' + Date.now();
let snapshot = null;

try {
  const all = await api('/api/articles');
  snapshot = (all.json && all.json.articles) || [];

  const body = ['# 第一节', '正文一段。', '', '![示意图](/og-image.png)', '', '## 第二节', '再来一段。', '', '### 第三节', '收尾。'].join('\n');
  const add = await api('/api/articles', { password: pw, action: 'add', article: { title, date: new Date().toISOString().slice(0, 10), summary: '门禁造数：配图放大', body, category: '技术' } });
  pass('造数：新增带配图的文章', add.status === 200 && add.json && add.json.ok, 'status=' + add.status + ' ' + JSON.stringify(add.json && add.json.error || ''));

  const after = await api('/api/articles');
  const mine = ((after.json && after.json.articles) || []).find((a) => a.title === title);
  artId = mine && mine.id;
  pass('拿到新文章的 slug', !!artId && !!mine.slug, String(mine && mine.slug));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/articles/' + encodeURI(mine.slug) + '.html' });
  await sleep(2200);

  pass('阅读器已打开', (await ev("!document.getElementById('reader').hidden")) === true, '');
  pass('正文图片已标记可放大', (await ev("document.querySelectorAll('#rBody img.zoomable').length")) === 1, '');
  pass('图片可聚焦且声明为按钮', (await ev("(function(){var i=document.querySelector('#rBody img');return !!i && i.tabIndex===0 && i.getAttribute('role')==='button';})()")) === true, '');
  pass('灯箱初始隐藏', (await ev("document.getElementById('lightbox').hidden")) === true, '');

  await ev("document.querySelector('#rBody img').click()");
  await sleep(300);
  pass('点图片后灯箱出现', (await ev("!document.getElementById('lightbox').hidden")) === true, '');
  pass('灯箱里是同一张图', (await ev("(document.getElementById('lbImg').src||'').indexOf('og-image.png')>=0")) === true, '');
  pass('灯箱打开时锁滚动', (await ev("document.body.classList.contains('lb-open')")) === true, '');
  pass('焦点落在关闭按钮', (await ev("document.activeElement && document.activeElement.id")) === 'lbClose', String(await ev("document.activeElement && document.activeElement.id")));

  await key('Escape', 'Escape', 27);
  await sleep(300);
  pass('Esc 关闭灯箱', (await ev("document.getElementById('lightbox').hidden")) === true, '');
  pass('Esc 没有误关阅读器', (await ev("!document.getElementById('reader').hidden")) === true, '');
  pass('关闭后解除滚动锁', (await ev("document.body.classList.contains('lb-open')")) === false, '');

  await ev("document.querySelector('#rBody img').click()");
  await sleep(250);
  await ev("document.getElementById('lightbox').click()");
  await sleep(250);
  pass('点遮罩空白处也能关', (await ev("document.getElementById('lightbox').hidden")) === true, '');

  await ev("document.querySelector('#rBody img').focus()");
  await key('Enter', 'Enter', 13);
  await sleep(250);
  pass('键盘 Enter 也能放大', (await ev("!document.getElementById('lightbox').hidden")) === true, '');
  await ev("document.getElementById('lbClose').click()");
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  if (artId) {
    const del = await api('/api/articles', { password: pw, action: 'remove', id: artId });
    const left = await api('/api/articles');
    const still = ((left.json && left.json.articles) || []).filter((a) => a.title === title || a.id === artId);
    pass('清理测试文章', del.status === 200 && still.length === 0, 'left=' + still.length);
  }
}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（' + ok + ' 项）');
process.exit(bad ? 1 : 0);
