// 榜单分页器步进门禁：−/＋ 点一下走一页、长按连点、边界夹取、输入框 Enter 仍可用。
// 用法：先起 dev-server（8123），再 node scripts/check-pager-step.mjs [--shot 输出png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shotArg = process.argv.indexOf('--shot');
const shotOut = shotArg > -1 ? process.argv[shotArg + 1] : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  [' + (d == null ? '' : d) + ']')); if (!c) fails++; };
const pageOf = (txt) => { const m = /第\s*(\d+)\s*\/\s*(\d+)\s*页/.exec(String(txt || '')); return m ? { page: +m[1], pages: +m[2] } : null; };

const port = 9200 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pstep-'));
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
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 240) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/?v=' + Date.now() });
  await sleep(3200);

  console.log('== 1. 控件齐全 ==');
  const meta = await ev(`(() => {
    const d=document.getElementById('pgDec'), i=document.getElementById('pgInc'), inp=document.getElementById('pgJump');
    if(!d||!i||!inp) return null;
    const r=d.getBoundingClientRect();
    return { dec:d.getAttribute('aria-label'), inc:i.getAttribute('aria-label'), w:Math.round(r.width), h:Math.round(r.height), info:document.getElementById('pageInfo').textContent, value:inp.value, max:inp.max };
  })()`);
  ok('有 −/＋ 两个按钮', !!meta, JSON.stringify(meta));
  ok('减号有 aria-label', meta && /减一/.test(meta.dec || ''), meta && meta.dec);
  ok('加号有 aria-label', meta && /加一/.test(meta.inc || ''), meta && meta.inc);
  ok('按钮够大（≥28×28）', meta && meta.w >= 28 && meta.h >= 28, meta && (meta.w + 'x' + meta.h));
  const p0 = pageOf(meta && meta.info);
  ok('当前在第 1 页', p0 && p0.page === 1, meta && meta.info);

  console.log('== 2. 点一下 ＋ 之后一页 ==');
  const up = await ev(`(() => {
    const i=document.getElementById('pgInc');
    i.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
    i.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));
    return new Promise(r=>setTimeout(()=>r({ value:document.getElementById('pgJump').value, info:document.getElementById('pageInfo').textContent }),900));
  })()`);
  const p1 = pageOf(up && up.info);
  ok('输入框变成 2', up && up.value === '2', up && up.value);
  ok('列表真的翻到第 2 页', p1 && p1.page === 2, up && up.info);

  console.log('== 3. 再点一下 − 回到第 1 页 ==');
  const dn = await ev(`(() => {
    const d=document.getElementById('pgDec');
    d.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
    d.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));
    return new Promise(r=>setTimeout(()=>r({ value:document.getElementById('pgJump').value, info:document.getElementById('pageInfo').textContent }),900));
  })()`);
  const p2 = pageOf(dn && dn.info);
  ok('输入框回到 1', dn && dn.value === '1', dn && dn.value);
  ok('列表真的回到第 1 页', p2 && p2.page === 1, dn && dn.info);

  console.log('== 4. 边界夹取（第 1 页再按 −）==');
  const clamp = await ev(`(() => {
    const d=document.getElementById('pgDec');
    d.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
    d.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));
    return new Promise(r=>setTimeout(()=>r({ value:document.getElementById('pgJump').value, info:document.getElementById('pageInfo').textContent }),700));
  })()`);
  ok('不会变成 0 或负数', clamp && clamp.value === '1', clamp && clamp.value);
  ok('仍在第 1 页', pageOf(clamp && clamp.info) && pageOf(clamp.info).page === 1, clamp && clamp.info);

  console.log('== 5. 长按 ＋ 连点 ==');
  const hold = await ev(`(() => {
    const i=document.getElementById('pgInc');
    i.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
    return new Promise(res=>setTimeout(()=>{
      i.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));
      setTimeout(()=>res({ value:document.getElementById('pgJump').value, info:document.getElementById('pageInfo').textContent }), 900);
    }, 1100));
  })()`);
  ok('长按连点让页码涨了 ≥3', hold && parseInt(hold.value, 10) >= 4, hold && hold.value);
  const hp = pageOf(hold && hold.info);
  ok('松手后列表跟着跳过去', hp && String(hp.page) === String(hold.value), (hold && hold.info) + ' vs value ' + (hold && hold.value));

  console.log('== 6. 输入框手输仍有作用 ==');
  const typed = await ev(`(() => {
    const inp=document.getElementById('pgJump');
    inp.value='3';
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    return new Promise(r=>setTimeout(()=>r({ info:document.getElementById('pageInfo').textContent, value:inp.value }),900));
  })()`);
  ok('输入 3 后到第 3 页', pageOf(typed && typed.info) && pageOf(typed.info).page === 3, typed && typed.info);

  if (shotOut) {
    await ev(`(() => { const p=document.getElementById('pager'); if(p) p.scrollIntoView({block:'center'}); return 1; })()`);
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(shotOut, Buffer.from(shot.result.data, 'base64'));
    console.log('saved ' + shotOut + ' ' + fs.statSync(shotOut).size + 'B');
  }
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
