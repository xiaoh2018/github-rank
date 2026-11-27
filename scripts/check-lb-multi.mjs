// 门禁：灯箱多图左右切换（计数、首尾边界、左右键不翻文章）
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

const title = '__门禁__多图切换 ' + Date.now();
const body = [
  '# 多图演示',
  '正文第一段。',
  '',
  '![第一张](/og-image.png?i=1)',
  '',
  '## 中间',
  '第二张在下面。',
  '',
  '![第二张](/og-image.png?i=2)',
  '',
  '### 结尾',
  '最后一张。',
  '',
  '![第三张](/og-image.png?i=3)',
].join('\n');
const add = await api('/api/articles', { password: pw, action: 'add', article: { title, date: '2026-11-26', summary: '门禁：多图切换', body, category: '技术' } });
let artId = '';
let mine = null;
try {
  pass('造数：新增 3 图文章', add.status === 200 && add.json && add.json.ok, JSON.stringify(add.json && add.json.error || ''));
  const all = await api('/api/articles');
  mine = ((all.json && all.json.articles) || []).find((a) => a.title === title);
  artId = mine && mine.id;
  pass('拿到 slug', !!mine && !!mine.slug, String(mine && mine.slug));

  const port = 10900 + Math.floor(Math.random() * 80);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-lbm-'));
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
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };
  const key = async (k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };
  const cnt = async () => ev("(function(){var c=document.getElementById('lbCount');return c? (c.hidden?'hidden':c.textContent) : 'none';})()");
  const src = async () => ev("document.getElementById('lbImg').src || ''");

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base + '/articles/' + encodeURI(mine.slug) + '.html' });
    await sleep(2200);

    pass('正文里有 3 张图且都可放大', (await ev("document.querySelectorAll('#rBody img.zoomable').length")) === 3, '');
    const title0 = await ev("document.getElementById('rTitle').textContent");

    await ev("document.querySelectorAll('#rBody img')[0].click()");
    await sleep(350);
    pass('打开第 1 张：计数 1 / 3', (await cnt()) === '1 / 3', String(await cnt()));
    pass('第 1 张时「上一张」隐藏', (await ev("document.getElementById('lbPrev').hidden")) === true, '');
    pass('第 1 张时「下一张」可见', (await ev("document.getElementById('lbNext').hidden")) === false, '');
    pass('显示的是第 1 张', /i=1/.test(await src()), await src());

    await key('ArrowRight', 'ArrowRight', 39);
    await sleep(300);
    pass('→ 到第 2 张（计数 2 / 3）', (await cnt()) === '2 / 3', String(await cnt()));
    pass('→ 后图片真的换了', /i=2/.test(await src()), await src());

    await key('ArrowRight', 'ArrowRight', 39);
    await sleep(300);
    pass('→ 到第 3 张（计数 3 / 3）', (await cnt()) === '3 / 3', String(await cnt()));
    pass('最后一张时「下一张」隐藏', (await ev("document.getElementById('lbNext').hidden")) === true, '');

    await key('ArrowRight', 'ArrowRight', 39);
    await sleep(300);
    pass('在最后一张再按 → 不越界', (await cnt()) === '3 / 3', String(await cnt()));

    pass('左右键没有翻到别的文章', (await ev("document.getElementById('rTitle').textContent")) === title0, '');
    pass('灯箱仍然打开', (await ev("document.getElementById('lightbox').open")) === true, '');

    await ev("document.getElementById('lbPrev').click()");
    await sleep(300);
    pass('点「上一张」回到 2 / 3', (await cnt()) === '2 / 3', String(await cnt()));

    await key('Escape', 'Escape', 27);
    await sleep(300);
    pass('Esc 关灯箱后阅读器仍在', (await ev("!document.getElementById('lightbox').open && !document.getElementById('reader').hidden")) === true, '');

    await ev("document.querySelectorAll('#rBody img')[2].click()");
    await sleep(300);
    pass('点第 3 张直接定位到 3 / 3', (await cnt()) === '3 / 3', String(await cnt()));
  } finally {
    try { ws.close(); } catch {}
    try { child.kill(); } catch {}
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  }
} finally {
  if (artId) {
    const del = await api('/api/articles', { password: pw, action: 'remove', id: artId });
    const left = await api('/api/articles');
    const still = ((left.json && left.json.articles) || []).filter((a) => a.title === title);
    pass('清理测试文章', del.status === 200 && still.length === 0, 'left=' + still.length);
  }
}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（' + ok + ' 项）');
process.exit(bad ? 1 : 0);
