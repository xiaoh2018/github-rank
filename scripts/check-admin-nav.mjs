// 后台导航行内「打开」链接：可点、可访问名、触摸尺寸、窄屏不溢出。node scripts/check-admin-nav.mjs [W]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.argv[2] || 1440);
const port = 9600 + Math.floor(Math.random() * 200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, '--window-size=' + W + ',900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map();
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
      break;
    }
  } catch {}
  await sleep(200);
}
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + r.result.exceptionDetails.text);
  return r.result && r.result.result ? r.result.result.value : null;
};
const base = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const rows = [];
const push = (n, ok, extra) => { rows.push(ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (extra ? '  → ' + extra : '')); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__errs=[];window.addEventListener("error",function(e){window.__errs.push((e.message||"?")+" @"+e.lineno+":"+e.colno)});' });
await send('Page.navigate', { url: base + '/admin' });
await sleep(1300);
await js("sessionStorage.setItem('adminPw','dev')");
await send('Page.navigate', { url: base + '/admin' });
await sleep(2200);
push('后台脚本无同步异常', (await js('(window.__errs||[]).length')) === 0, JSON.stringify(await js('window.__errs')));
await js("document.querySelector('.side .nav[data-tab=\"nav\"]').click()");
await sleep(900);

const info = await js(`(function(){
  var pane=document.getElementById('pane-nav');
  var rows=Array.prototype.slice.call(document.querySelectorAll('#navAdmin tbody tr'));
  var links=rows.map(function(tr){var a=tr.querySelector('a.nav-open');return a?{href:a.getAttribute('href'),target:a.getAttribute('target'),rel:a.getAttribute('rel'),label:a.getAttribute('aria-label')||'',h:Math.round(a.getBoundingClientRect().height)}:null;});
  return {paneShown:pane?getComputedStyle(pane).display:'none',rows:rows.length,links:links,headOp:(document.querySelector('#navAdmin thead th:last-child')||{}).textContent||'',sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,offCss:(document.querySelectorAll('.nav-open.off').length)};})()`);
push('导航面板已打开且有站点行', info.paneShown !== 'none' && info.rows >= 10, JSON.stringify({ rows: info.rows }));
const links = info.links.filter(Boolean);
push('每行都有「打开」链接', links.length === info.rows, links.length + '/' + info.rows);
push('全部新标签打开（target=_blank）', links.every((l) => l.target === '_blank'));
push('全部带 rel=noopener', links.every((l) => (l.rel || '').indexOf('noopener') >= 0));
push('href 都是 http(s)', links.every((l) => /^https?:/i.test(l.href || '')), JSON.stringify(links.slice(0, 2)));
push('可访问名含「打开」与站点名', links.every((l) => l.label.indexOf('打开') === 0 && l.label.length > 3), JSON.stringify(links.slice(0, 2).map((x) => x.label)));
push('触摸尺寸 ≥28px', links.every((l) => l.h >= 28), 'minH=' + Math.min.apply(null, links.map((l) => l.h)));
push('操作列表头仍存在', /操作/.test(info.headOp || ''));
push('窄屏无横向溢出', info.sw <= info.cw + 1, 'sw=' + info.sw + ' cw=' + info.cw);

// 点一下「打开」不改变当前页（新标签），且不触发导航
const before = await js('location.href');
const box = await js(`(function(){var a=document.querySelector('#navAdmin tbody a.nav-open');a.scrollIntoView({block:'center',behavior:'instant'});var r=a.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
await sleep(200);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await sleep(600);
const after = await js('location.href');
push('点「打开」不会把后台导航走', before === after, before === after ? 'ok' : before + ' -> ' + after);

const bad = rows.filter((x) => !x).length;
console.log('\n' + (bad ? 'FAILED ' + bad + '/' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + W + 'px  ' + base);
ws.close();
proc.kill();
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(bad ? 1 : 0);