// 保存按钮的分派：点每个 [data-save] 按钮，看它到底 POST 到哪个接口
// 旧版靠数花括号推断「分支可达」—— ADMIN_PAGE 里全是内联 CSS/JS，括号数不准，误报过 qa / nav 不可达。
// 现在改成行为测试：真点按钮 + 拦请求看 URL，验证的是用户实际遇到的行为。
// 用法：node scripts/check-save-dispatch.mjs   （只跑本地；后台写操作需要密码）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const PW = process.env.ADMIN_PW || 'dev';

let pass = 0;
let fail = 0;
const rows = [];
const push = (name, ok, info) => {
  rows.push((ok ? 'OK   ' : 'FAIL ') + name + (info === undefined ? '' : '  → ' + info));
  ok ? pass++ : fail++;
};

const port = 9600 + Math.floor(Math.random() * 300);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const proc = spawn(chrome, [
  '--headless=new',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + userDir,
  '--window-size=1440,900',
  '--no-first-run',
  'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
let id = 0;
const pending = new Map();
const paused = [];

for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
      });
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
          return;
        }
        if (m.method === 'Fetch.requestPaused') paused.push(m.params);
      };
      break;
    }
  } catch {}
  await sleep(200);
}
if (!ws) {
  console.error('连不上 CDP：可能有残留 headless chrome 占着端口，先清掉再跑');
  process.exit(2);
}
const send = (method, params) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result && r.result.result ? r.result.result.value : null;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

// 拦截器：/api/* 一律记下来并回 200 {ok:true}；其它请求放行
let recording = true;
let calls = [];
const pump = setInterval(async () => {
  while (paused.length) {
    const p = paused.shift();
    const u = p.request.url;
    const isApi = /\/api\//.test(u);
    if (isApi && recording) {
      calls.push({ path: u.replace(BASE, '').split('?')[0], method: p.request.method, post: p.request.postData || '' });
    }
    try {
      if (isApi) {
        const body = Buffer.from(JSON.stringify({ ok: true })).toString('base64');
        await send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
          body: body,
        });
      } else {
        await send('Fetch.continueRequest', { requestId: p.requestId });
      }
    } catch (e) {}
  }
}, 30);

await send('Page.navigate', { url: BASE + '/admin' });
await sleep(2200);
await ev("sessionStorage.setItem('adminPw', " + JSON.stringify(PW) + ")");
await send('Page.reload', { ignoreCache: true });
await sleep(2600);
const gateShown = await ev("getComputedStyle(document.getElementById('gate')).display");
push('后台已登录（gate 隐藏）', gateShown === 'none', String(gateShown));

// data-save → 期望接口
const MAP = [
  ['qa', '/api/qa'],
  ['nav', '/api/nav'],
  ['theme', '/api/site'],
  ['layout', '/api/site'],
  ['contact', '/api/site'],
  ['beian', '/api/site'],
  ['seo', '/api/site'],
  ['geo', '/api/site'],
  ['ad', '/api/site'],
  ['runtime', '/api/site'],
];

for (const [key, expect] of MAP) {
  calls = [];
  const clicked = await ev(
    "(function(){var b=document.querySelector('[data-save=\"" + key + "\"]'); if(!b) return 'missing'; b.click(); return 'ok';})()"
  );
  if (clicked !== 'ok') {
    push('[' + key + '] 保存按钮存在', false, String(clicked));
    continue;
  }
  await sleep(900);
  const my = calls.slice();
  const hit = my.filter((c) => c.method === 'POST');
  const ok = hit.length === 1 && hit[0].path === expect;
  push('[' + key + '] 点保存 POST 到 ' + expect, ok, hit.map((c) => c.path).join(',') || '（没有发出请求）');
}

// 文章弹窗：保存按钮是 #artSubmit（不是 data-save="article" —— 那是「保存文章设置」，本来就该打 /api/site）
calls = [];
const artOpened = await ev("(function(){var b=document.getElementById('artNew'); if(!b) return 'missing'; b.click(); return 'ok';})()");
await sleep(700);
const artFilled = await ev(
  "(function(){var t=document.getElementById('artTitleIn'),s=document.getElementById('artSummary'),b=document.getElementById('artBody');" +
    "if(!t||!s||!b) return 'no-fields';" +
    "t.value='保存分派测试'; s.value='测试摘要'; b.value='测试正文';" +
    "[t,s,b].forEach(function(el){el.dispatchEvent(new Event('input',{bubbles:true}));});" +
    "var btn=document.getElementById('artSubmit'); if(!btn) return 'no-button'; btn.click(); return 'ok';})()"
);
await sleep(1100);
const artErr = await ev("(function(){var e=document.getElementById('artErr'); return e?(e.textContent||'').trim():'';})()");
const artPosts = calls.filter((c) => c.method === 'POST');
push(
  '[文章弹窗] #artSubmit POST 到 /api/articles',
  artOpened === 'ok' && artFilled === 'ok' && artPosts.length === 1 && artPosts[0].path === '/api/articles',
  (artPosts.map((c) => c.path).join(',') || '（没有发出请求）') + (artErr ? ' 面板报错：' + artErr : '')
);

// 反向：任何一次点击都不该出现「两个请求」或「打到别的接口」
calls = [];
await ev("(function(){var b=document.querySelector('[data-save=\"qa\"]'); b && b.click();})()");
await sleep(1200);
push('单次点击只发一个请求（不重复提交）', calls.filter((c) => c.method === 'POST').length === 1, String(calls.length) + ' 个请求');

clearInterval(pump);
console.log(rows.join('\n'));
console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL OK (' + pass + ')') + '  @' + BASE);
try {
  ws.close();
} catch {}
try {
  proc.kill();
} catch {}
try {
  fs.rmSync(userDir, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);
