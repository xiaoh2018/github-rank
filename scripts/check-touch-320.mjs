// 门禁：320px / 568px 小屏下，空态按钮与命令面板条目的触控尺寸
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function session(width, height) {
  const port = 9890 + Math.floor(Math.random() * 40);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-t320-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' });
  const wsUrl = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        const page = list.find((t) => t.type === 'page');
        if (page) return page.webSocketDebuggerUrl;
      } catch {}
      await sleep(250);
    }
    throw new Error('chrome not ready');
  })();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waits = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  return { ws, child, send, evalJs };
}

// 1) /nav 空态按钮
{
  const s = await session(320, 720);
  await s.send('Page.navigate', { url: BASE + '/nav' });
  await sleep(2400);
  await s.evalJs("var i=document.getElementById('navSearch'); i.value='zzzznotexist'; i.dispatchEvent(new Event('input',{bubbles:true}));");
  await sleep(700);
  const r = await s.evalJs(`(function(){
    var e = document.querySelector('.navempty');
    if (!e) return { missing: true };
    var act = e.querySelector('button, a.btn, .btn');
    var ar = act ? act.getBoundingClientRect() : null;
    var er = e.getBoundingClientRect();
    return { w: Math.round(er.width), padTop: parseInt(getComputedStyle(e).paddingTop, 10),
             actH: ar ? Math.round(ar.height) : null, actText: act ? act.textContent.trim().slice(0,12) : null,
             docW: document.documentElement.scrollWidth, cliW: document.documentElement.clientWidth };
  })()`);
  push('导航页空态存在（搜乱码）', r && !r.missing, JSON.stringify(r));
  push('导航页空态按钮高 ≥ 44', r && r.actH >= 44, r && r.actH);
  push('导航页空态内边距收敛（上下 ≤ 24）', r && r.padTop <= 24, r && r.padTop);
  push('导航页不横向溢出', r && r.docW <= r.cliW + 1, r ? r.docW + '/' + r.cliW : '');
  s.ws.close(); s.child.kill();
}

// 2) /faq 空态按钮
{
  const s = await session(320, 720);
  await s.send('Page.navigate', { url: BASE + '/faq?q=zzzznotexist' });
  await sleep(2600);
  const r = await s.evalJs(`(function(){
    var e = document.querySelector('.empty');
    if (!e) return { missing: true };
    var act = e.querySelector('button, .chip, .btn');
    var ar = act ? act.getBoundingClientRect() : null;
    var er = e.getBoundingClientRect();
    return { w: Math.round(er.width), padTop: parseInt(getComputedStyle(e).paddingTop, 10),
             actH: ar ? Math.round(ar.height) : null, actText: act ? act.textContent.trim().slice(0,14) : null,
             docW: document.documentElement.scrollWidth, cliW: document.documentElement.clientWidth };
  })()`);
  push('问答页空态存在（搜乱码）', r && !r.missing, JSON.stringify(r));
  push('问答页空态按钮高 ≥ 44', r && r.actH >= 44, r && r.actH);
  push('问答页空态内边距收敛（上下 ≤ 24）', r && r.padTop <= 24, r && r.padTop);
  push('问答页不横向溢出', r && r.docW <= r.cliW + 1, r ? r.docW + '/' + r.cliW : '');
  s.ws.close(); s.child.kill();
}

// 3) /articles 空态
{
  const s = await session(320, 720);
  await s.send('Page.navigate', { url: BASE + '/articles?q=zzzznotexist' });
  await sleep(2600);
  const r = await s.evalJs(`(function(){
    var e = document.querySelector('.empty');
    if (!e) return { missing: true };
    return { w: Math.round(e.getBoundingClientRect().width), padTop: parseInt(getComputedStyle(e).paddingTop, 10),
             docW: document.documentElement.scrollWidth, cliW: document.documentElement.clientWidth };
  })()`);
  push('文章页空态存在（搜乱码）', r && !r.missing, JSON.stringify(r));
  push('文章页空态内边距收敛（上下 ≤ 28）', r && r.padTop <= 28, r && r.padTop);
  push('文章页不横向溢出', r && r.docW <= r.cliW + 1, r ? r.docW + '/' + r.cliW : '');
  s.ws.close(); s.child.kill();
}

// 4) 后台命令面板（320×568）
{
  const s = await session(320, 568);
  await s.send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1800);
  await s.evalJs("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit();");
  await sleep(1600);
  await s.evalJs("document.getElementById('cmdkFab').click();");
  await sleep(700);
  const r = await s.evalJs(`(function(){
    var d = document.getElementById('cmdk');
    if (!d || !d.open) return { open: false };
    var item = d.querySelector('.ck-item');
    var ir = item ? item.getBoundingClientRect() : null;
    var box = d.firstElementChild;
    var br = box ? box.getBoundingClientRect() : null;
    var list = d.querySelector('.ck-list');
    return {
      open: true,
      itemH: ir ? Math.round(ir.height) : null,
      top: br ? Math.round(br.top) : null,
      bottom: br ? Math.round(br.bottom) : null,
      vh: window.innerHeight,
      listScroll: list ? list.scrollHeight : null,
      listClient: list ? list.clientHeight : null,
      listOf: list ? getComputedStyle(list).overflowY : null
    };
  })()`);
  push('命令面板能打开（点 ⌘）', r && r.open, JSON.stringify(r));
  push('命令面板条目高 ≥ 44', r && r.itemH >= 44, r && r.itemH);
  push('命令面板整框在视口内（top ≥ 0 且 bottom ≤ 视口高）', r && r.top >= 0 && r.bottom <= r.vh, r ? r.top + '..' + r.bottom + ' / ' + r.vh : '');
  push('命令面板列表可滚动（内容高于可视）', r && r.listScroll > r.listClient && r.listOf === 'auto', r ? r.listScroll + '/' + r.listClient + ' ' + r.listOf : '');
  const copy = await s.evalJs("(function(){var f=document.getElementById('ckFoot'); var i=document.getElementById('ckInput'); return { foot: f?f.textContent.trim():null, ph: i?i.placeholder:null };})()");
  push('手机上面板底部提示改成触屏措辞', copy && copy.foot === '点一下面板名就跳过去', copy && copy.foot);
  push('手机上面板输入框占位符缩短', copy && copy.ph === '搜面板名…', copy && copy.ph);
  s.ws.close(); s.child.kill();
}

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? '全部通过（' + rows.length + ' 项，320px）' : bad + ' 项失败 / ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
