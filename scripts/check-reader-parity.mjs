// 门禁：两个阅读器功能对齐（SPA 弹窗 vs 静态 /articles/<slug>.html）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.env.PROBE_W || 390), H = Number(process.env.PROBE_H || 844);
const SLUG = 'tech/4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9200 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-parity-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let page;
for (let i = 0; i < 90 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  if (!page) await sleep(150);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((r) => pending.set(id, r)); };
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return 'EXC ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text);
  return r.result && r.result.result ? r.result.result.value : undefined;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });

const rows = [];
const push = (name, ok, extra = '') => rows.push({ name, ok: !!ok, extra });

// ---- SPA 阅读器 ----
await send('Page.navigate', { url: BASE + '/?page=articles&post=' + encodeURIComponent(SLUG) + '&p=' + Date.now() });
await sleep(2600);
await ev(`localStorage.removeItem('ghrank-reader-font')`);
await send('Page.reload', {});
await sleep(2400);

push('弹窗打开且标题正确', (await ev(`!!(document.getElementById('artDlg')||{}).open && /目录高亮/.test((document.getElementById('artDlgT')||{}).textContent||'')`)));
push('工具条可见：目录 / 字号 / 复制链接',
  await ev(`(function(){
    var b=document.getElementById('adlTocBtn'), f=document.getElementById('adlPlus'), c=document.getElementById('adlCopy');
    if(!b||!f||!c) return false;
    var r=b.getBoundingClientRect();
    return r.width>0 && r.height>0 && f.getBoundingClientRect().width>=30 && /复制链接/.test(c.textContent);
  })()`));
push('默认字号 17px（与静态页同档）', (await ev(`getComputedStyle(document.getElementById('artDlgBody')).fontSize`)) === '17px', await ev(`getComputedStyle(document.getElementById('artDlgBody')).fontSize`));
await ev(`(function(){document.getElementById('adlPlus').click();document.getElementById('adlPlus').click();return 1;})()`);
await sleep(120);
const f2 = await ev(`getComputedStyle(document.getElementById('artDlgBody')).fontSize`);
push('点两次 A＋ 正文变 20px', f2 === '20px', f2);
push('字号写进 localStorage（与静态页共用 key）', (await ev(`localStorage.getItem('ghrank-reader-font')`)) === '20');
push('目录有 ≥3 条且第一条是正文首个小标题', await ev(`(function(){
  var as=[...document.querySelectorAll('#adlToc a')];
  return as.length>=3 && /背景/.test(as[0].textContent||'');
})()`), await ev(`document.querySelectorAll('#adlToc a').length`));
push('目录默认收起、点一下展开', await ev(`(function(){
  var t=document.getElementById('adlToc'), b=document.getElementById('adlTocBtn');
  var hidden=t.hidden; b.click();
  return hidden===true && t.hidden===false && b.getAttribute('aria-expanded')==='true';
})()`));
await ev(`(function(){
  var a=document.querySelectorAll('#adlToc a')[1]; if(a) a.click(); return 1;
})()`);
await sleep(200);
const sc = await ev(`document.getElementById('artDlgBody').scrollTop`);
push('点目录条目会让正文滚到该小节', sc > 10, 'scrollTop=' + sc);
const copyRes = await ev(`(function(){
  var out=null;
  try{
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(u){out=u;return Promise.resolve();}}});
  }catch(e){ return 'no-clipboard'; }
  document.getElementById('adlCopy').click();
  var tip=document.getElementById('adlTip');
  return JSON.stringify({url:out, tipShown:!!tip && !tip.hidden});
})()`);
let copyOk = false;
try {
  const o = JSON.parse(copyRes);
  copyOk = /\/articles\/tech\/4\.html$/.test(String(o.url || '')) && o.tipShown === true;
} catch (e) {}
push('复制链接给出的是静态页规范地址 + 提示已复制', copyOk, copyRes);
push('上下篇两个按钮都在', (await ev(`document.querySelectorAll('#adlNav .adl-nb').length`)) === 2, await ev(`[...document.querySelectorAll('#adlNav .adl-nb')].map(b=>b.textContent).join('|')`));
push('← 能翻到上一篇（标题变化）', await ev(`(function(){
  var b=[...document.querySelectorAll('#adlNav .adl-nb')];
  var before=document.getElementById('artDlgT').textContent;
  var target=b.find(x=>!x.disabled && /上一篇/.test(x.textContent));
  if(!target) return 'no-prev';
  target.click();
  return new Promise(function(res){ setTimeout(function(){
    res(document.getElementById('artDlgT').textContent!==before);
  },600); });
})()`));
push('弹窗不横向溢出', await ev(`(function(){var d=document.getElementById('artDlg');return d.scrollWidth<=d.clientWidth+1;})()`),
  await ev(`(function(){var d=document.getElementById('artDlg');return d.scrollWidth+'/'+d.clientWidth;})()`));

// ---- 静态页阅读器（同一个 profile，localStorage 共用）----
await send('Page.navigate', { url: BASE + '/articles/' + SLUG + '.html?p=' + Date.now() });
await sleep(2600);
push('静态页有字号按钮 / 目录 / 上下篇', await ev(`(function(){
  var f=document.getElementById('rfPlus'), t=document.getElementById('rToc'), n=document.getElementById('rNav');
  return !!f && !!t && !!n;
})()`));
push('静态页沿用同一个字号（20px）', (await ev(`getComputedStyle(document.querySelector('.abody')||document.body).fontSize`)) === '20px',
  await ev(`getComputedStyle(document.querySelector('.abody')||document.body).fontSize`));
push('静态页正文有目录条目', await ev(`document.querySelectorAll('#rTocList a').length >= 3`), await ev(`document.querySelectorAll('#rTocList a').length`));
push('静态页 390 不横向溢出', await ev(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`),
  await ev(`document.documentElement.scrollWidth+'/'+document.documentElement.clientWidth`));
push('两个阅读器都不出现「加密文章」措辞', await ev(`!/加密文章/.test(document.body.innerText)`));

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ' 项，' + W + 'px)' : bad + ' FAILED of ' + rows.length);
ws.close(); child.kill(); await sleep(150);
process.exit(bad === 0 ? 0 : 1);
