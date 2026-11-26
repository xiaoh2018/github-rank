import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.env.W || 1440);
const BASE = process.env.BASE || 'http://127.0.0.1:8123';
const PORT = 9500 + Math.floor(Math.random() * 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, '--window-size=' + W + ',900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map();
const listeners = [];
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        listeners.forEach((fn) => fn(m));
      };
      break;
    }
  } catch {}
  await sleep(200);
}
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + expr.slice(0, 90));
  return r.result && r.result.result ? r.result.result.value : null;
};

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('OK   ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 2, mobile: W < 800 });

await send('Page.navigate', { url: BASE + '/admin' });
await sleep(900);
await js("sessionStorage.setItem('adminPw','dev')");
await send('Page.navigate', { url: BASE + '/admin' });
await sleep(2200);

check('后台登录成功（gate 隐藏、app 可见）', await js("(function(){var g=document.getElementById('gate'),a=document.getElementById('app');return getComputedStyle(g).display==='none' && getComputedStyle(a).display!=='none';})()"));

const html = await (await fetch(BASE + '/admin')).text();
check('站点地址单一来源：模板里用 __SITE__ 占位（不再硬编码）', !html.includes('github.661026.xyz') && html.includes('/sitemap.xml'), { hasOrigin: html.includes(BASE + '/sitemap.xml') });

await js("(function(){var n=Array.prototype.find.call(document.querySelectorAll('.side .nav'),function(e){return /收录/.test(e.textContent)}); if(n) n.click();})()");
await sleep(1500);
check('收录面板打开', await js("(function(){var p=document.getElementById('pane-submit');return !!p && !p.hidden;})()"));

const groups = await js("Array.prototype.map.call(document.querySelectorAll('#subStatus .sgroup'),function(g){return (g.querySelector('.sgh')||{}).textContent;})");
check('状态分成三组（凭据 / 站点 / 记录）', Array.isArray(groups) && groups.join(',') === '凭据,站点,记录', groups);
check('每行状态都在某个组里', await js("(function(){var all=document.querySelectorAll('#subStatus .status-item');var inside=0;Array.prototype.forEach.call(all,function(el){if(el.closest('.sgroup'))inside++;});return all.length>0 && inside===all.length;})()"));

check('状态区不再重复渲染「上次 IndexNow」', !(await js("document.getElementById('subStatus').innerHTML.includes('上次 IndexNow')")));
check('GEO 平台清单卡片有锚点（#geoCard）', await js("!!document.getElementById('geoCard')"));

// 拦截 POST /api/submit，回一个假结果，验证「接下来」出口
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/submit', requestStage: 'Request' }] });
listeners.push((m) => {
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    if (request.method === 'POST') {
      const body = JSON.stringify({
        ok: true, urls: 5, root: 'https://example.test',
        results: {
          indexNow: { ok: true, status: 202, ms: 118, note: '202 已接收；IndexNow 会把结果回给 Bing', raw: '202 Accepted', urlList: ['https://example.test/', 'https://example.test/articles'], urlListNote: '前 2 条' },
          baidu: { ok: true, status: 200, ms: 96, note: '成功 5 条', raw: '{"success":5,"remain":95}' },
        },
      });
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(body).toString('base64') });
    } else {
      send('Fetch.continueRequest', { requestId });
    }
  }
});
await js("document.getElementById('subRun').click()");
await sleep(1500);
const out = await js("document.getElementById('subOut').innerHTML");
check('提交结果里显示本次推了多少地址', /本次提交 <b>5<\/b>/.test(out), out.slice(0, 60));
check('结果里有 IndexNow 与百度两块', out.includes('IndexNow（Bing') && out.includes('百度普通收录'));
check('结果里有「看原始返回」折叠', out.includes('看原始返回'));
check('结果里有「这次推了 2 条地址」折叠', out.includes('这次推了 2 条地址'));
const next = await js("(function(){var n=document.querySelector('#subOut .tr-next');if(!n)return null;var as=Array.prototype.map.call(n.querySelectorAll('a'),function(a){return {href:a.getAttribute('href'),rel:a.getAttribute('rel'),t:a.textContent};});return {text:n.textContent.replace(/\\s+/g,' ').trim().slice(0,40),links:as};})()");
check('结果下面有「接下来」出口 + 3 个链接', !!next && next.links.length === 3, next);
check('外链都带 rel=noopener 且是 https', !!next && next.links.slice(0, 2).every((a) => a.rel === 'noopener' && /^https:/.test(a.href)), next && next.links);
check('「本页平台清单」是锚点（同页跳转）', !!next && next.links[2].href === '#geoCard');

const over = await js(`(function(){var vw=document.documentElement.clientWidth;var wide=[];Array.prototype.forEach.call(document.getElementById('pane-submit').querySelectorAll('*'),function(el){var r=el.getBoundingClientRect();if(r.width>0&&r.right>vw+1)wide.push(el.tagName+'.'+String(el.className).slice(0,20));});return {vw:vw,sw:document.documentElement.scrollWidth,wide:wide.slice(0,6)};})()`);
check('窄屏/常规宽度都不横向溢出', over && over.sw === over.vw && over.wide.length === 0, over);

const btnState = await js("(function(){var b=document.getElementById('subRun');return {disabled:b.disabled,text:b.textContent};})()");
check('提交后按钮恢复可点', btnState && btnState.disabled === false && /全部提交/.test(btnState.text), btnState);

console.log('\n' + (fail ? 'FAILED ' : 'ALL OK ') + '(' + pass + '/' + (pass + fail) + ')  @' + W + 'px  ' + BASE);
ws.close();
proc.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);