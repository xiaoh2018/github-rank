// 键盘可达性门禁：跳转链接、迷你按钮的可访问名、聚焦后可见。
// 用法：node scripts/check-kbd.mjs [width] [height]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; const fails = [];
const ok = (name, cond, info = '') => { if (cond) { pass++; console.log('OK   ' + name); } else { fails.push(name + (info ? ' — ' + info : '')); console.log('FAIL ' + name + (info ? ' — ' + info : '')); } };

const port = 9910 + Math.floor(Math.random() * 60);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-kbdgate-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  if (!page) await sleep(250);
}
if (!page) { console.error('no cdp target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const myId = ++id; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((r) => pending.set(myId, r)); };
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.text || '');
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 761 });
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

const pages = [
  { url: '/', skip: '#list', target: '#list', name: '首页' },
  { url: '/articles', skip: 'a.skip', target: '#cards', name: '文章页' },
  { url: '/faq', skip: 'a.skip', target: '#list', name: '问答页' },
];

for (const p of pages) {
  await send('Page.navigate', { url: BASE + p.url + '?kbd=' + Date.now() });
  await sleep(2600);
  const first = await ev(`(() => { document.body.focus(); const sel='a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'; const all=[...document.querySelectorAll(sel)].filter(el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'}); const a=all[0]; return a ? a.tagName+'|'+(a.className||'')+'|'+a.textContent.trim().slice(0,10) : 'none'; })()`);
  ok(p.name + '：第一个可聚焦元素是跳转链接', String(first).indexOf('skip') >= 0, first);

  const before = await ev(`(() => { const a=document.querySelector('a.skip'); if(!a) return null; const r=a.getBoundingClientRect(); return { left: Math.round(r.left), visible: r.width>0 && r.height>0 }; })()`);
  ok(p.name + '：跳转链接默认在视口外（不占视线）', before && before.visible && before.left < -100, JSON.stringify(before));

  await ev(`(() => { const a=document.querySelector('a.skip'); a.focus(); })()`);
  await sleep(120);
  const after = await ev(`(() => { const a=document.querySelector('a.skip'); const r=a.getBoundingClientRect(); const s=getComputedStyle(a); return { left: Math.round(r.left), top: Math.round(r.top), ring: s.outlineStyle!=='none' }; })()`);
  ok(p.name + '：聚焦后跳转链接出现在左上角', after && after.left >= 0 && after.top < 60, JSON.stringify(after));
  ok(p.name + '：聚焦后可见焦点环', !!after && after.ring === true, JSON.stringify(after));

  await ev(`document.querySelector('a.skip').click()`);
  await sleep(400);
  const jumped = await ev(`(() => { const t=document.querySelector('${p.target}'); const a=document.activeElement; return { hash: location.hash, top: t ? Math.round(t.getBoundingClientRect().top) : null, y: Math.round(window.scrollY), focused: !!(t && a && (t === a || t.contains(a))) }; })()`);
  ok(p.name + '：跳转后焦点进入正文（键盘从这里继续）', jumped && jumped.top !== null && (jumped.focused === true || (jumped.top < 200 && jumped.y > 0)), JSON.stringify(jumped));
}

// 迷你按钮的可访问名 + 聚焦可见
await send('Page.navigate', { url: BASE + '/?kbd2=' + Date.now() });
await sleep(2600);
const mini = await ev(`(() => {
  const btns = [...document.querySelectorAll('#list .mini')];
  const named = btns.filter(b => (b.getAttribute('aria-label') || '').length >= 4).length;
  const first = btns[0];
  if (first) first.focus();
  const op = first ? 'pending' : null;
  const inList = [...document.querySelectorAll('#list a[href],#list button')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
  const cards = document.querySelectorAll('#list .item').length;
  return { total: btns.length, named, opAfterFocus: op, inList, cards };
})()`);
ok('卡片按钮都有可访问名（aria-label）', mini && mini.named === mini.total && mini.total > 0, JSON.stringify(mini));
await sleep(200);
const opNow = await ev(`(() => {
  const b = document.querySelector('#list .mini');
  if (!b) return { skip: true };
  if (getComputedStyle(b).display === 'none') return { skip: true, reason: 'mobile 隐藏（设计如此）' };
  b.focus();
  return { skip: false, focused: document.activeElement === b };
})()`);
await sleep(260);
const opAfter = await ev(`(() => { const b = document.querySelector('#list .mini'); return b ? getComputedStyle(b).opacity : null; })()`);
if (opNow && opNow.skip) { pass++; console.log('OK   卡片迷你按钮在此视口不显示（移动端设计如此，跳过隐形焦点检查）'); }
else ok('聚焦卡片内迷你按钮时它会显形（不是隐形焦点）', Number(opAfter) === 1, 'opacity=' + opAfter + ' focused=' + (opNow && opNow.focused));
ok('每张卡的可聚焦控件数 ≤ 4（标题 / 复制 / 卡片 / 收藏）', mini && mini.cards > 0 && mini.inList <= mini.cards * 4, JSON.stringify(mini));

console.log(fails.length ? '\nFAILED ' + fails.length + ' / ' + (pass + fails.length) : '\nALL OK (' + pass + ' 项，' + W + 'px)');
try { await send('Browser.close'); } catch {}
child.kill();
process.exit(fails.length ? 1 : 0);