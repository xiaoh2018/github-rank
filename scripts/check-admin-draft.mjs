import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 900);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'OK   ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : '')); };

const port = 9300 + Math.floor(Math.random() * 400);
const dir = path.join(os.tmpdir(), 'cdp-draft-' + Date.now());
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=' + port, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
let ws; const pending = new Map(); let seq = 0;
const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + e.slice(0, 80)); return r.result.value; };

try {
  await sleep(900);
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: W < 800 });
  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1500);
  await ev("localStorage.removeItem('ghrank-art-draft'); document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); true");
  await sleep(1800);
  await ev("document.querySelector('.nav[data-tab=\"articles\"]').click(); true");
  await sleep(600);

  ok('标题是 h2（不再错配成 h3 闭合）', await ev("(function(){var h=document.getElementById('artTitle');return h.tagName==='H2' && !document.querySelector('#artDlg h3#artTitle');})()"));

  await ev("document.getElementById('artNew').click(); true");
  await sleep(400);
  ok('新文章弹窗已打开', await ev("document.getElementById('artDlg').open === true"));
  ok('初始没有「未保存」徽标', await ev("document.getElementById('artDirtyBadge').hidden === true"));

  await ev(`(function(){
    var t = document.getElementById('artTitleIn');
    t.value = '__门禁__草稿标题';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    var b = document.getElementById('artBody');
    b.value = '# 草稿正文\\n\\n这段不该丢。';
    b.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  ok('改了内容出现「未保存」徽标', await ev("document.getElementById('artDirtyBadge').hidden === false"));

  await sleep(900);
  ok('草稿已写进 localStorage', await ev("!!localStorage.getItem('ghrank-art-draft')"));

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  const esc = await ev("(function(){var d=document.getElementById('delDlg');return {open:d.open,note:document.getElementById('delNote').textContent,btn:document.getElementById('delSubmit').textContent};})()");
  ok('按 Esc 会先弹出「还没保存」确认', esc.open === true && /还没保存/.test(esc.note), JSON.stringify(esc));
  ok('确认框按钮文案是「放弃改动」', esc.btn === '放弃改动', esc.btn);

  await ev("document.querySelector('#delDlg [data-close]').click(); true");
  await sleep(400);
  const afterCancel = await ev("(function(){return {art:document.getElementById('artDlg').open,del:document.getElementById('delDlg').open};})()");
  ok('取消后编辑弹窗还在（没丢）', afterCancel.art === true && afterCancel.del === false, JSON.stringify(afterCancel));

  await ev("document.querySelector('#artDlg [data-close]').click(); true");
  await sleep(400);
  ok('再点「关闭」又会拦一次', await ev("document.getElementById('delDlg').open === true"));
  await ev("document.getElementById('delSubmit').click(); true");
  await sleep(500);
  ok('确认放弃后编辑弹窗关闭', await ev("document.getElementById('artDlg').open === false"));

  await ev("document.getElementById('artNew').click(); true");
  await sleep(500);
  const bar = await ev("(function(){var b=document.getElementById('draftBar');return {hidden:b.hidden,text:document.getElementById('draftText').textContent};})()");
  ok('再次写新文章会提示上次的草稿', bar.hidden === false && /上次没保存的草稿/.test(bar.text), JSON.stringify(bar));
  ok('草稿条带标题预览', /__门禁__草稿标题/.test(bar.text), bar.text);

  await ev("document.getElementById('draftRestore').click(); true");
  await sleep(400);
  const restored = await ev("(function(){return {title:document.getElementById('artTitleIn').value, body:document.getElementById('artBody').value};})()");
  ok('点「恢复草稿」把标题填回来', restored.title === '__门禁__草稿标题', restored.title);
  ok('正文也一起恢复', /这段不该丢/.test(restored.body));

  await ev("localStorage.setItem('ghrank-art-draft', JSON.stringify({title:'x',body:'y',at:Date.now()})); true");
  await ev("document.getElementById('draftDrop') && document.getElementById('draftDrop').click(); true");
  await sleep(1100);
  ok('点「丢弃」会清掉本机草稿', await ev("!localStorage.getItem('ghrank-art-draft')"));

  ok('整页不横向溢出', await ev("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), await ev("document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth"));
} catch (e) {
  fail++;
  console.log('FAIL 运行异常  [' + e.message + ']');
} finally {
  try { await ev("localStorage.removeItem('ghrank-art-draft'); true"); } catch {}
  try { await send('Browser.close'); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(fail === 0 ? 'ALL OK (' + pass + ')' : fail + ' FAILED of ' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
}
