// 后台「文章」面板按分类筛选门禁（CDP 真点下拉）。
// 用法：先起 dev-server（8123），再 node scripts/check-catfilter.mjs [--shot 输出png]
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

const arts = await (await fetch(base + '/data/articles.json')).json().catch(() => []);
const list = Array.isArray(arts) ? arts : (arts.articles || []);
const withCat = list.filter((a) => a.category);
const target = withCat.length ? withCat[0].category : '';
const expect = withCat.filter((a) => a.category === target).length;
if (!target) { console.error('没有带分类的文章，先建一篇再跑'); process.exit(1); }

const port = 9600 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-catf-'));
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
  await ev(`(() => { const n=document.querySelector('.nav[data-tab="articles"]'); if(n) n.click(); return 1; })()`);
  await sleep(1200);

  console.log('== 1. 下拉存在且有选项 ==');
  const meta = await ev(`(() => {
    const sel=document.getElementById('artCatFilter');
    if(!sel) return null;
    return { opts:[...sel.options].map(o=>o.value), rows:document.querySelectorAll('#artTbody tr').length, aria:sel.getAttribute('aria-label') };
  })()`);
  ok('有 #artCatFilter', !!meta, JSON.stringify(meta));
  ok('有「全部分类」空选项', meta && meta.opts[0] === '', meta && JSON.stringify(meta.opts));
  ok('含真实分类「' + target + '」', meta && meta.opts.indexOf(target) > -1, meta && JSON.stringify(meta.opts));
  ok('下拉有 aria-label', meta && /分类/.test(meta.aria || ''), meta && meta.aria);
  const beforeRows = meta ? meta.rows : -1;

  console.log('== 2. 选分类后只剩该分类 ==');
  const filtered = await ev(`(() => {
    const sel=document.getElementById('artCatFilter');
    sel.value=${JSON.stringify(target)};
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return new Promise(res=>setTimeout(()=>res({ rows:document.querySelectorAll('#artTbody tr').length, note:document.getElementById('artSearchNote').textContent, cells:[...document.querySelectorAll('#artTbody tr td:nth-child(3) .slot-id')].map(x=>x.textContent) }),350));
  })()`);
  ok('行数等于该分类篇数（' + expect + '）', filtered && filtered.rows === expect, filtered && filtered.rows);
  ok('提示写明分类', filtered && filtered.note.indexOf('分类「' + target + '」') > -1, filtered && filtered.note);
  ok('行内分类标签都一致', filtered && filtered.cells.every((c) => c === target), filtered && JSON.stringify(filtered.cells));

  console.log('== 3. 切回全部 ==');
  const reset = await ev(`(() => {
    const sel=document.getElementById('artCatFilter');
    sel.value='';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return new Promise(res=>setTimeout(()=>res({ rows:document.querySelectorAll('#artTbody tr').length, note:document.getElementById('artSearchNote').textContent }),350));
  })()`);
  ok('行数回到筛选前', reset && reset.rows === beforeRows, (reset && reset.rows) + ' vs ' + beforeRows);
  ok('提示清空', reset && reset.note === '', JSON.stringify(reset && reset.note));

  if (shotOut) {
    await ev(`(() => { const sel=document.getElementById('artCatFilter'); sel.value=${JSON.stringify(target)}; sel.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(shotOut, Buffer.from(shot.result.data, 'base64'));
    console.log('saved ' + shotOut + ' ' + fs.statSync(shotOut).size + 'B');
    await ev(`(() => { const sel=document.getElementById('artCatFilter'); sel.value=''; sel.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
  }
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
