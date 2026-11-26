// 后台封面字段：口径与前台一致（允许站内相对路径）+ 实时预览
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PW = process.env.ADMIN_PW || 'dev';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-covadm-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 120 && !target; i++) { try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(150); }
if (!target) { console.error('no cdp page'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result && r.result.exceptionDetails) throw new Error(String((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text));
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const rows = [];
const push = (name, ok, extra) => { rows.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE + '/admin?t=' + Date.now() });
await sleep(2800);
await ev("(function(){var p=document.getElementById('pw'); if(p) p.value='dev'; var b=document.getElementById('loginBtn'); if(b) b.click(); return 1;})()");
await sleep(1800);
await ev("(function(){var n=document.querySelector('[data-tab=\"articles\"]')||document.querySelector('.side .nav'); if(n) n.click(); return 1;})()");
await sleep(900);
push('后台已登录并能进「文章」面板', await ev("!!document.getElementById('artNew')"));
await ev("(function(){var b=document.getElementById('artNew'); if(b) b.click(); return 1;})()");
await sleep(700);
push('「写新文章」弹窗打开', await ev("(function(){var d=document.querySelector('dialog[open]'); return !!d;})()"));
push('封面输入框是文本框（能填站内路径）', (await ev("(function(){var i=document.getElementById('artCover'); return i? i.getAttribute('type') : '';})()")) === 'text');
push('没填封面时预览区不出现', await ev("(function(){var w=document.getElementById('covPrevWrap'); return !!w && w.hidden === true;})()"));

// A. 站内相对路径 → 预览出图并报尺寸
await ev("(function(){var i=document.getElementById('artCover'); i.value='/og-image.png'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()");
await sleep(1400);
const prevA = await ev("(function(){var w=document.getElementById('covPrevWrap'),i=document.getElementById('covPrevImg'),s=document.getElementById('covState'); return {shown:!!w&&!w.hidden, w:i?i.naturalWidth:0, h:i?i.naturalHeight:0, state:s?s.textContent:'', bad:s?s.classList.contains('bad'):false};})()");
push('站内路径能出预览（自然宽度 > 0）', prevA && prevA.shown && prevA.w > 0, prevA);
push('预览报出图片尺寸', prevA && /\d+×\d+/.test(prevA.state) && !prevA.bad, prevA && prevA.state);

// B. 非法协议 → 当场说清
await ev("(function(){var i=document.getElementById('artCover'); i.value='javascript:alert(1)'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()");
await sleep(700);
const prevB = await ev("(function(){var i=document.getElementById('covPrevImg'),s=document.getElementById('covState'); return {src:i?i.getAttribute('src'):null, state:s?s.textContent:'', bad:s?s.classList.contains('bad'):false};})()");
push('非法协议不给预览、文字说清', prevB && !prevB.src && prevB.bad && /http/i.test(prevB.state), prevB);

// C. 打不开的地址 → 明确报错
await ev("(function(){var i=document.getElementById('artCover'); i.value='https://example.invalid/nope.png'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()");
await sleep(2200);
const prevC = await ev("(function(){var s=document.getElementById('covState'); return {state:s?s.textContent:'', bad:s?s.classList.contains('bad'):false};})()");
push('打不开的图会报错（不是静默）', prevC && prevC.bad && /打不开/.test(prevC.state), prevC);

// D. 清空 → 预览收起
await ev("(function(){var i=document.getElementById('artCover'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()");
await sleep(600);
push('清空后预览收起', await ev("(function(){var w=document.getElementById('covPrevWrap'); return !!w && w.hidden === true;})()"));

// E. 服务端口径：站内路径可保存、非法协议被拒（线上只读，跳过写操作）
if (!REMOTE) {
  const addOk = await ev(`fetch('/api/articles',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({password:${JSON.stringify(PW)},action:'add',article:{title:'封面口径自检',summary:'临时文章，自检后删除',body:'x',cover:'/og-image.png',category:'tech',tags:[]}})}).then(r=>r.json())`);
  push('站内路径可以保存（服务端不再拒绝 / 开头）', addOk && addOk.ok, addOk && addOk.error);
  const saved = (addOk && addOk.articles || []).filter((a) => a.title === '封面口径自检')[0];
  push('保存后封面原样是 /og-image.png', saved && saved.cover === '/og-image.png', saved && saved.cover);
  const badAdd = await ev(`fetch('/api/articles',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({password:${JSON.stringify(PW)},action:'add',article:{title:'封面非法自检',summary:'x',body:'x',cover:'javascript:alert(1)',category:'tech',tags:[]}})}).then(r=>r.json())`);
  push('非法协议被服务端拒绝且说清理由', badAdd && badAdd.ok === false && /http/i.test(badAdd.error || ''), badAdd && badAdd.error);
  const del = await ev(`fetch('/api/articles',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({password:${JSON.stringify(PW)},action:'remove',id:'${saved ? saved.id : '0'}'})}).then(r=>r.json())`);
  push('自检产生的临时文章已删除', del && del.ok, del && del.error);
} else {
  const html = await ev("document.documentElement.innerText.length > 0");
  push('线上只读核对（写操作跳过）', html === true);
}

const hint = await ev("(function(){var i=document.getElementById('artCover'); var d=i?i.closest('div,p,section'):null; return document.body.innerText.indexOf('站内以 / 开头的路径') >= 0;})()");
push('提示里说明了站内路径写法', hint === true);

ws.close();
try { child.kill(); } catch {}
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + '/' + rows.length : 'ALL OK (' + rows.length + ')') + (REMOTE ? '  [online]' : ''));
process.exit(bad.length ? 1 : 0);
