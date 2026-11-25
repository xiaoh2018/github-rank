// 文章搜索「命中片段 + 高亮」门禁：正文命中给上下文、摘要命中也标来源、清空后恢复摘要。
// 用法：先起 dev-server（8123），再 node scripts/check-search-highlight.mjs [--shot 输出png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shotArg = process.argv.indexOf('--shot');
const shotOut = shotArg > -1 ? process.argv[shotArg + 1] : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  [' + (d == null ? '' : d) + ']')); if (!c) fails++; };
const TITLE = '__门禁__命中词文章';

const api = async (p, body) => {
  const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, json: await r.json().catch(() => null) };
};
const listArts = async () => {
  const j = (await api('/data/articles.json')).json;
  return Array.isArray(j) ? j : (j && j.articles) || [];
};

const port = 9300 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hl-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let tg;
for (let i = 0; i < 40 && !tg; i++) { try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); tg = l.find((x) => x.type === 'page'); } catch {} if (!tg) await sleep(250); }
if (!tg) { console.error('Chrome 没起来'); process.exit(1); }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pend.set(i, r)); };
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};

let createdId = '';
try {
  console.log('== 0. 造一篇正文含独有词的文章 ==');
  const add = await api('/api/articles', {
    password: PW,
    action: 'add',
    article: {
      title: TITLE,
      summary: '这是摘要，里面没有那个独有词，只有普通样例描述。',
      category: '技术',
      date: '2026-11-26',
      body: '# 标题\n\n开头一段普通文字。\n\n中间提到 ZZQ信号 这个词，后面还有更多内容。\n\n结尾。'
    }
  });
  ok('新建文章 200', add.status === 200, add.status + ' ' + JSON.stringify(add.json).slice(0, 120));
  const created = (add.json && add.json.articles ? add.json.articles : await listArts()).find((x) => x.title === TITLE);
  createdId = created && created.id;
  ok('列表里能查到这篇', !!createdId, JSON.stringify(add.json).slice(0, 120));

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/articles?v=' + Date.now() });
  await sleep(3200);

  console.log('== 1. 搜正文里的独有词 ==');
  const body1 = await ev(`(() => {
    const s=document.getElementById('search'); s.value='ZZQ'; s.dispatchEvent(new Event('input',{bubbles:true}));
    return new Promise(r=>setTimeout(()=>{
      const cards=[...document.querySelectorAll('#cards .acard')];
      const one=cards[0];
      const mk=one&&one.querySelector('mark.hitmark');
      const src=one&&one.querySelector('.hitsrc');
      const st=mk?getComputedStyle(mk):null;
      r({ n:cards.length, hasLine:!!(one&&one.querySelector('.hitline')), mark:mk?mk.textContent:'', src:src?src.textContent:'', bg:st?st.backgroundColor:'', p:one?one.querySelector('p').textContent:'' });
    },600));
  })()`);
  ok('只命中 1 篇', body1 && body1.n === 1, body1 && body1.n);
  ok('出现命中片段行', body1 && body1.hasLine, JSON.stringify(body1).slice(0, 160));
  ok('命中词被 <mark> 包住且大小写原样', body1 && body1.mark === 'ZZQ', body1 && body1.mark);
  ok('片段来源标「正文命中」', body1 && /正文命中/.test(body1.src || ''), body1 && body1.src);
  ok('片段带了上下文（不止搜索词本身）', body1 && body1.p && body1.p.length > 12, body1 && body1.p);
  ok('mark 有背景色（可视化高亮）', body1 && body1.bg && body1.bg !== 'rgba(0, 0, 0, 0)', body1 && body1.bg);

  console.log('== 2. 搜摘要里的词 ==');
  const body2 = await ev(`(() => {
    const s=document.getElementById('search'); s.value='样例'; s.dispatchEvent(new Event('input',{bubbles:true}));
    return new Promise(r=>setTimeout(()=>{
      const one=document.querySelector('#cards .acard');
      const src=one&&one.querySelector('.hitsrc');
      const mk=one&&one.querySelector('mark.hitmark');
      r({ n:document.querySelectorAll('#cards .acard').length, src:src?src.textContent:'', mark:mk?mk.textContent:'' });
    },600));
  })()`);
  ok('摘要命中时标「摘要命中」', body2 && /摘要命中/.test(body2.src || ''), body2 && body2.src);
  ok('摘要命中词也高亮', body2 && body2.mark === '样例', body2 && body2.mark);

  console.log('== 3. 只命中标题时不替换摘要 ==');
  const body3 = await ev(`(() => {
    const s=document.getElementById('search'); s.value='命中词文章'; s.dispatchEvent(new Event('input',{bubbles:true}));
    return new Promise(r=>setTimeout(()=>{
      const one=document.querySelector('#cards .acard');
      r({ n:document.querySelectorAll('#cards .acard').length, hasLine:!!(one&&one.querySelector('.hitline')), text:one?one.querySelector('p').textContent:'' });
    },600));
  })()`);
  ok('只命中标题仍是 1 篇', body3 && body3.n === 1, body3 && body3.n);
  ok('标题命中时不换成片段', body3 && body3.hasLine === false, JSON.stringify(body3).slice(0, 160));
  ok('摘要原文还在', body3 && /这是摘要/.test(body3.text || ''), body3 && body3.text);

  console.log('== 4. 清空搜索恢复 ==');
  const body4 = await ev(`(() => {
    const s=document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true}));
    return new Promise(r=>setTimeout(()=>{
      r({ n:document.querySelectorAll('#cards .acard').length, marks:document.querySelectorAll('#cards mark.hitmark').length, lines:document.querySelectorAll('#cards .hitline').length });
    },600));
  })()`);
  ok('清空后有多篇', body4 && body4.n > 1, body4 && body4.n);
  ok('清空后没有残留高亮', body4 && body4.marks === 0 && body4.lines === 0, JSON.stringify(body4));

  if (shotOut) {
    await ev(`(() => { const s=document.getElementById('search'); s.value='ZZQ'; s.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
    await sleep(700);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(shotOut, Buffer.from(shot.result.data, 'base64'));
    console.log('saved ' + shotOut + ' ' + fs.statSync(shotOut).size + 'B');
  }
} finally {
  try { if (createdId) await api('/api/articles', { password: PW, action: 'remove', id: createdId }); } catch {}
  try {
    const left = (await listArts()).filter((x) => String(x.title || '').indexOf('__门禁__') === 0);
    console.log('残留门禁文章: ' + left.length);
    if (left.length) fails++;
  } catch {}
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
