// 后台「问答」面板筛选门禁：关键词输入框必须真的过滤（此前是死代码）+ 标签下拉。
// 用法：先起 dev-server（8123），再 node scripts/check-qafilter.mjs [--shot 输出png]
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

const qa = await (await fetch(base + '/data/qa.json')).json().catch(() => ({}));
const items = Array.isArray(qa.items) ? qa.items : [];
const tags = [...new Set(items.map((i) => String(i.tag || '').trim()).filter(Boolean))];
if (!items.length || !tags.length) { console.error('问答数据为空或没有标签，先建几条再跑'); process.exit(1); }
const tag = tags[0];
const expectTag = items.filter((i) => String(i.tag || '').trim() === tag).length;
const kw = String(items[0].q || '').slice(0, 4);

const port = 9500 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-qaf-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let tg;
for (let i = 0; i < 40 && !tg; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); tg = l.find((x) => x.type === 'page'); } catch {}
  if (!tg) await sleep(250);
}
if (!tg) { console.error('Chrome 没起来'); process.exit(1); }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pend.set(i, r)); };
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 240) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/admin?v=' + Date.now() });
  await sleep(2000);
  await ev(`(() => { const p=document.getElementById('pw'); if(p) p.value='${PW}'; const f=document.getElementById('loginForm'); if(f) f.requestSubmit(); return 1; })()`);
  await sleep(1800);
  await ev(`(() => { const n=document.querySelector('.nav[data-tab="qa"]'); if(n) n.click(); return 1; })()`);
  await sleep(1200);

  console.log('== 1. 控件齐全 ==');
  const meta = await ev(`(() => {
    const sel=document.getElementById('qaTagFilter');
    if(!sel) return null;
    return { opts:[...sel.options].map(o=>o.value), rows:document.querySelectorAll('#qaList .qa-row').length, msg:document.getElementById('qaMsg').textContent, aria:sel.getAttribute('aria-label') };
  })()`);
  ok('有 #qaTagFilter', !!meta, JSON.stringify(meta));
  ok('含「全部标签」空选项', meta && meta.opts[0] === '', meta && JSON.stringify(meta.opts));
  ok('含标签「' + tag + '」', meta && meta.opts.indexOf(tag) > -1, meta && JSON.stringify(meta.opts));
  ok('下拉有 aria-label', meta && /标签/.test(meta.aria || ''), meta && meta.aria);
  ok('初始行数 = 全部条数（' + items.length + '）', meta && meta.rows === items.length, meta && meta.rows);
  const beforeRows = meta ? meta.rows : -1;

  console.log('== 2. 按标签筛 ==');
  const byTag = await ev(`(() => {
    const sel=document.getElementById('qaTagFilter');
    sel.value=${JSON.stringify(tag)};
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return new Promise(res=>setTimeout(()=>res({ rows:document.querySelectorAll('#qaList .qa-row').length, msg:document.getElementById('qaMsg').textContent }),320));
  })()`);
  ok('行数 = 该标签条数（' + expectTag + '）', byTag && byTag.rows === expectTag, byTag && byTag.rows);
  ok('提示显示「显示 X / 共 N 条」', byTag && /显示 \d+ \/ 共 \d+ 条/.test(byTag.msg || ''), byTag && byTag.msg);

  console.log('== 3. 关键词过滤真的生效（原先是死代码）==');
  const byKw = await ev(`(() => {
    const sel=document.getElementById('qaTagFilter'); sel.value=''; sel.dispatchEvent(new Event('change',{bubbles:true}));
    const inp=document.getElementById('qaFilter');
    inp.value=${JSON.stringify(kw)};
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    return new Promise(res=>setTimeout(()=>res({ rows:document.querySelectorAll('#qaList .qa-row').length, msg:document.getElementById('qaMsg').textContent }),320));
  })()`);
  ok('关键词「' + kw + '」有命中', byKw && byKw.rows >= 1, byKw && byKw.rows);
  ok('关键词命中数少于全部', byKw && byKw.rows < beforeRows, (byKw && byKw.rows) + ' vs ' + beforeRows);
  ok('提示也显示「显示 X / 共 N 条」', byKw && /显示 \d+ \/ 共 \d+ 条/.test(byKw.msg || ''), byKw && byKw.msg);

  console.log('== 4. 无结果与清空 ==');
  const none = await ev(`(() => {
    const inp=document.getElementById('qaFilter');
    inp.value='zzz-不存在的关键词-zzz';
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    return new Promise(res=>setTimeout(()=>res({ rows:document.querySelectorAll('#qaList .qa-row').length, empty:!!document.querySelector('#qaList .empty'), msg:document.getElementById('qaMsg').textContent }),320));
  })()`);
  ok('无命中时 0 行 + 空态文案', none && none.rows === 0 && none.empty === true, JSON.stringify(none));
  const cleared = await ev(`(() => {
    const inp=document.getElementById('qaFilter'); inp.value=''; inp.dispatchEvent(new Event('input',{bubbles:true}));
    return new Promise(res=>setTimeout(()=>res({ rows:document.querySelectorAll('#qaList .qa-row').length, msg:document.getElementById('qaMsg').textContent }),320));
  })()`);
  ok('清空后恢复全部', cleared && cleared.rows === beforeRows, cleared && cleared.rows);
  ok('清空后提示回到「共 N 条」', cleared && /^共 \d+ 条$/.test(cleared.msg || ''), cleared && cleared.msg);

  if (shotOut) {
    await ev(`(() => { const sel=document.getElementById('qaTagFilter'); sel.value=${JSON.stringify(tag)}; sel.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(shotOut, Buffer.from(shot.result.data, 'base64'));
    console.log('saved ' + shotOut + ' ' + fs.statSync(shotOut).size + 'B');
    await ev(`(() => { const sel=document.getElementById('qaTagFilter'); sel.value=''; sel.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
  }
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
