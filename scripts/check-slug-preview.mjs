// 门禁：写文章弹窗里的链接实时预览（分类词/序号 → /articles/<cat>/<seq>.html，撞地址要红字提醒）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const pw = process.env.GHRANK_PW || 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const pass = (n, c, e) => { if (c) { ok++; console.log('  PASS  ' + n); } else { bad++; console.log('  FAIL  ' + n + (e ? '  [' + e + ']' : '')); } };

const port = 10700 + Math.floor(Math.random() * 80);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-sp-'));
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
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };
const setVal = async (id, v) => ev("(function(){var e=document.getElementById('" + id + "');e.value=" + JSON.stringify(v) + ";e.dispatchEvent(new Event('input',{bubbles:true}));return e.value;})()");
const prev = async () => ev("(function(){var b=document.getElementById('artSlugPrev');return JSON.stringify({t:b?b.textContent:'',c:b?b.className:'',hidden:b?b.offsetParent===null:true});})()").then((x) => JSON.parse(x || '{}'));

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/admin' });
  await sleep(1500);
  await ev("(function(){document.getElementById('pw').value='" + pw + "';document.getElementById('loginForm').requestSubmit();return 1;})()");
  await sleep(1600);
  const logged = await ev("(function(){var a=document.getElementById('app');return !!a && !a.hidden;})()");
  pass('后台已登录', logged === true, '');

  await ev("document.querySelector('.nav[data-tab=\"articles\"]').click()");
  await sleep(700);
  await ev("document.getElementById('artNew').click()");
  await sleep(700);
  const dlgOpen = await ev("document.getElementById('artDlg').open === true");
  pass('写文章弹窗已打开', dlgOpen === true, '');

  const p0 = await prev();
  pass('未填分类时提示先选分类', /选好分类/.test(p0.t || '') && !/warn/.test(p0.c || ''), p0.t);

  await setVal('artCategory', '技术');
  await sleep(200);
  const p1 = await prev();
  pass('中文分类落成 cat/<序号>.html', /\/articles\/cat\/\d+\.html/.test(p1.t || ''), p1.t);

  await setVal('artCat', 'tech');
  await setVal('artSeq', '');
  await sleep(200);
  const p2 = await prev();
  pass('英文分类词 + 自动序号', /\/articles\/tech\/\d+\.html/.test(p2.t || ''), p2.t);
  pass('自动序号会说明是自动取的', /自动取这个分类的下一个/.test(p2.t || ''), p2.t);
  pass('预览不是红色告警', !/warn/.test(p2.c || ''), p2.c);

  await setVal('artSeq', '99');
  await sleep(200);
  const p3 = await prev();
  pass('手填序号覆盖自动值', /\/articles\/tech\/99\.html/.test(p3.t || ''), p3.t);
  pass('手填序号时不再提示自动', !/自动取这个分类的下一个/.test(p3.t || ''), p3.t);

  await setVal('artSeq', '4');
  await sleep(200);
  const p4 = await prev();
  pass('撞已有地址时变红并说明会加 -2', /warn/.test(p4.c || '') && /占用/.test(p4.t || '') && /tech\/4-2/.test(p4.t || ''), p4.t + ' | ' + p4.c);

  await ev("(function(){document.querySelector('#artDlg [data-close=\"artDlg\"]').click();return 1;})()");
  await sleep(300);
  pass('关闭弹窗', (await ev("document.getElementById('artDlg').open === false")) === true, '');
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（' + ok + ' 项）');
process.exit(bad ? 1 : 0);
