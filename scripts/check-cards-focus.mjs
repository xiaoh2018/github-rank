// 门禁：卡片聚焦可见性（/ 与 /articles）＋ 后台表格窄屏横向滚动 ＋ reduced-motion
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const pw = process.env.GHRANK_PW || 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const pass = (n, c, e) => { if (c) { ok++; console.log('  PASS  ' + n); } else { bad++; console.log('  FAIL  ' + n + (e ? '  [' + e + ']' : '')); } };

const port = 10620 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-focus-'));
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
const goto = async (url) => { await send('Page.navigate', { url }); await sleep(2200); };
const tab = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await sleep(120);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // —— /articles 列表卡
  await goto(base + '/articles');
  const acardCount = await ev("document.querySelectorAll('.acard').length");
  pass('/articles 有文章卡', acardCount > 0, 'n=' + acardCount);

  const baseBorder = await ev("getComputedStyle(document.querySelector('.acard')).borderTopColor");
  await ev("document.querySelector('.acard').focus(); true");
  await sleep(320);
  const focusInfo = await ev(`(function(){
    var c = document.querySelector('.acard');
    return { active: document.activeElement === c, border: getComputedStyle(c).borderTopColor };
  })()`);
  pass('卡片可获得焦点', !!(focusInfo && focusInfo.active), JSON.stringify(focusInfo));
  pass(':focus-within 会换描边色', focusInfo && focusInfo.border !== baseBorder, baseBorder + ' -> ' + (focusInfo && focusInfo.border));

  await ev('document.activeElement.blur(); true');
  await sleep(80);
  await ev('document.body.focus(); true');
  let vis = null;
  for (let i = 0; i < 12 && !vis; i++) {
    await tab();
    vis = await ev(`(function(){
      var a = document.activeElement;
      if (!a || !a.matches) return null;
      if (!a.matches(':focus-visible')) return null;
      var s = getComputedStyle(a);
      return { tag: a.tagName, cls: a.className, outline: s.outlineStyle + ' ' + s.outlineWidth, color: s.outlineColor };
    })()`);
  }
  pass('键盘 Tab 能落到卡片链接上并显示焦点环', !!vis, JSON.stringify(vis));
  pass('焦点环是实线且有宽度', !!vis && vis.outline.indexOf('solid') >= 0 && parseFloat(vis.outline.split(' ')[1]) >= 2, vis && vis.outline);

  // —— reduced motion
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(150);
  const rm = await ev("getComputedStyle(document.querySelector('.acard')).transitionDuration");
  pass('reduced-motion 下卡片不再过渡', parseFloat(rm) <= 0.01, String(rm));
  await send('Emulation.setEmulatedMedia', { features: [] });

  // —— 首页文章卡
  await goto(base + '/');
  const artCount = await ev("document.querySelectorAll('.artcard').length");
  pass('首页有文章卡', artCount > 0, 'n=' + artCount);
  const beforeHome = await ev("(function(){var c=document.querySelector('.artcard');return c?getComputedStyle(c).borderTopColor:null})()");
  await ev("(function(){var c=document.querySelector('.artcard');var a=c&&c.querySelector('a');if(a)a.focus();return !!a})()");
  await sleep(320);
  const afterHome = await ev("(function(){var c=document.querySelector('.artcard');return c?getComputedStyle(c).borderTopColor:null})()");
  pass('首页卡 :focus-within 换描边', !!beforeHome && beforeHome !== afterHome, beforeHome + ' -> ' + afterHome);

  // —— 后台表格窄屏
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await goto(base + '/admin');
  await sleep(600);
  if (await ev("!!document.getElementById('gate')")) {
    await ev("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); true");
    await sleep(1800);
  }
  await ev("(function(){var a=document.querySelectorAll('.nav');for(var i=0;i<a.length;i++){if(a[i].getAttribute('data-tab')==='nav'){a[i].click();return true}}return false})()");
  await sleep(900);
  const tbl = await ev(`(function(){
    var table = document.querySelector('#navAdmin table');
    if (!table) return null;
    var wrap = table.closest('.card') || table.parentElement;
    return {
      overflowX: getComputedStyle(wrap).overflowX,
      tableMin: getComputedStyle(table).minWidth,
      cardScroll: wrap.scrollWidth,
      cardClient: wrap.clientWidth,
      docSw: document.documentElement.scrollWidth,
      docCw: document.documentElement.clientWidth
    };
  })()`);
  pass('导航表格外层可横向滚动', !!tbl && tbl.overflowX === 'auto', JSON.stringify(tbl));
  pass('窄屏表格给了最小宽度并真的溢出', !!tbl && parseFloat(tbl.tableMin) >= 500 && tbl.cardScroll > tbl.cardClient, tbl && tbl.tableMin + ' scroll=' + tbl.cardScroll + '/' + tbl.cardClient);
  pass('整页仍然不横向溢出', !!tbl && tbl.docSw === tbl.docCw, tbl && tbl.docSw + '/' + tbl.docCw);
} catch (e) {
  bad++;
  console.log('  FAIL  脚本异常  [' + (e && e.message) + ']');
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  console.log(bad === 0 ? '\n全部通过（' + ok + ' 项）' : '\n' + ok + ' 通过 / ' + bad + ' 失败');
  process.exit(bad === 0 ? 0 : 1);
}
