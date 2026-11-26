// 门禁：文章页分页器在 320px 的可用性（信息独占一行、两个 44px 按钮左右分布、禁用态变浅）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const PW = 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

// 1. 造数据：让文章总数 > PER(9)
// 注意：/api/articles 的 add 返回的是整张列表（不是单篇），要按标题回查 id
for (let i = 0; i < 8; i++) {
  await fetch(BASE + '/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password: PW,
      action: 'add',
      article: {
        title: '__门禁分页__' + i,
        summary: '分页门禁用',
        body: '分页门禁用正文 ' + i,
        category: 'note',
        date: '2026-01-' + String(10 + i).padStart(2, '0'),
      },
    }),
  });
}
const afterAdd = await (await fetch(BASE + '/api/articles')).json();
const created = (afterAdd.articles || []).filter((a) => String(a.title || '').indexOf('__门禁分页__') === 0).map((a) => a.id);
push('造出 8 篇测试文章', created.length === 8, created.length);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9600 + Math.floor(Math.random() * 60);
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pgn-'));
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=' + port, '--user-data-dir=' + udd, 'about:blank',
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome not ready');
}

try {
  const ws = new WebSocket(await wsUrl());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waits = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    waits.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + '/articles' });
  await sleep(2600);

  const m = await evalJs(`(function(){
    var pager = document.getElementById('apager');
    if (!pager || pager.hidden) return { hidden: true };
    var btns = pager.querySelectorAll('button');
    var span = pager.querySelector('span');
    var pr = pager.getBoundingClientRect();
    var s = span ? span.getBoundingClientRect() : null;
    var b0 = btns[0] ? btns[0].getBoundingClientRect() : null;
    var b1 = btns[1] ? btns[1].getBoundingClientRect() : null;
    return {
      hidden: false,
      paneW: Math.round(pr.width),
      span: s ? { w: Math.round(s.width), top: Math.round(s.top), bottom: Math.round(s.bottom), text: span.textContent } : null,
      btn0: b0 ? { w: Math.round(b0.width), h: Math.round(b0.height), l: Math.round(b0.left), r: Math.round(b0.right), top: Math.round(b0.top), disabled: btns[0].disabled, op: getComputedStyle(btns[0]).opacity } : null,
      btn1: b1 ? { w: Math.round(b1.width), h: Math.round(b1.height), l: Math.round(b1.left), r: Math.round(b1.right), top: Math.round(b1.top), disabled: btns[1].disabled } : null,
      count: btns.length,
      docW: document.documentElement.scrollWidth,
      cliW: document.documentElement.clientWidth
    };
  })()`);

  push('320px 下分页器可见', m && !m.hidden, JSON.stringify(m && m.count));
  push('两个按钮', m && m.count === 2, '');
  push('页码信息独占一行（宽度 ≥ 分页器 70%）', m && m.span && m.span.w >= m.paneW * 0.7, m && m.span ? m.span.w + '/' + m.paneW : '');
  push('页码信息在按钮上方', m && m.span && m.btn0 && m.span.bottom <= m.btn0.top + 1, m && m.span && m.btn0 ? m.span.bottom + '<=' + m.btn0.top : '');
  push('按钮高度 ≥ 44', m && m.btn0 && m.btn0.h >= 44 && m.btn1.h >= 44, m && m.btn0 ? m.btn0.h + '/' + m.btn1.h : '');
  push('按钮宽度 ≥ 96', m && m.btn0 && m.btn0.w >= 96 && m.btn1.w >= 96, m && m.btn0 ? m.btn0.w + '/' + m.btn1.w : '');
  push('两按钮左右分开（间距 ≥ 60）', m && m.btn1 && m.btn0 && m.btn1.l - m.btn0.r >= 60, m && m.btn1 && m.btn0 ? String(m.btn1.l - m.btn0.r) : '');
  push('首页时「上一页」禁用且变浅', m && m.btn0 && m.btn0.disabled && parseFloat(m.btn0.op) <= 0.5, m && m.btn0 ? m.btn0.op : '');
  push('页码文案含「第 1 /」', m && m.span && m.span.text.indexOf('第 1 /') >= 0, m && m.span ? m.span.text : '');
  push('整页不横向溢出', m && m.docW <= m.cliW + 1, m ? m.docW + '/' + m.cliW : '');

  // 点下一页
  await evalJs("document.querySelectorAll('#apager button')[1].click();");
  await sleep(600);
  const m2 = await evalJs("(function(){var s=document.querySelector('#apager span');return s?s.textContent:'-';})()");
  push('点「下一页」后到第 2 页', typeof m2 === 'string' && m2.indexOf('第 2 /') >= 0, m2);

  ws.close();
} finally {
  child.kill();
}

// 清理
if (created.length) {
  const r = await fetch(BASE + '/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW, action: 'bulk', ids: created, op: 'remove' }),
  });
  const j = await r.json();
  push('清理测试文章', !!(j && j.ok), j && j.removed);
}
const left = await (await fetch(BASE + '/api/articles')).text();
push('库里无测试文章残留', left.indexOf('__门禁分页__') < 0, '');

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? '全部通过（' + rows.length + ' 项）' : bad + ' 项失败 / ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
