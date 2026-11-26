// 后台对话框无障碍：同步异常 / aria-modal / Tab 首尾环 / Esc 收口 / 关闭还焦点。node scripts/check-admin-dlg-a11y.mjs [W]
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
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
        return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('no page');
}
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + r.result.exceptionDetails.text);
  return r.result && r.result.result ? r.result.result.value : null;
};
const base = process.env.PROBE_BASE || 'http://127.0.0.1:8123';

const rows = [];
const push = (name, ok, extra) => { rows.push(ok); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra ? '  → ' + extra : '')); };

async function box(sel) {
  return js("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()");
}
async function click(sel) {
  await js("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");if(e&&e.scrollIntoView)e.scrollIntoView({block:'center',behavior:'instant'});})()");
  await sleep(180);
  const b = await box(sel);
  if (!b) throw new Error('no ' + sel);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await sleep(340);
}
async function key(k, code, vk, mods) {
  const m = mods || 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: m });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: m });
  await sleep(130);
}
const firstItem = (dlgId) => js("(function(){var d=document.getElementById(" + JSON.stringify(dlgId) + ");var l=d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])');for(var i=0;i<l.length;i++){var r=l[i].getBoundingClientRect();if(!l[i].closest('[hidden]')&&(r.width||r.height))return l[i].tagName+'#'+(l[i].id||'');}return '';})()");
const state = (dlgId) => js("(function(){var d=document.getElementById(" + JSON.stringify(dlgId) + ");var a=document.activeElement;return {open:d.open,modal:d.getAttribute('aria-modal'),inside:d.contains(a),active:a.tagName+'#'+(a.id||''),body:a===document.body};})()");

await connect();
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__errs=[];window.addEventListener("error",function(e){window.__errs.push((e.message||"?")+" @"+e.lineno+":"+e.colno)});' });
await send('Page.navigate', { url: base + '/admin?t=' + Date.now() });
await sleep(1300);
await js("sessionStorage.setItem('adminPw','dev')");
await send('Page.navigate', { url: base + '/admin?t=' + Date.now() });
await sleep(2100);
push('后台脚本无同步异常（error 事件为空）', (await js('(window.__errs||[]).length')) === 0, JSON.stringify(await js('window.__errs')));
await click('.side .nav[data-tab="articles"]');

// A. 写文章弹窗
await click('#artNew');
let st = await state('artDlg');
push('写文章弹窗 aria-modal=true', !!(st && st.modal === 'true'), JSON.stringify(st));
push('打开后焦点在弹窗内', !!(st && st.open && st.inside));
const total = await js("(function(){var d=document.getElementById('artDlg');var l=d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])');var c=0;for(var i=0;i<l.length;i++){var r=l[i].getBoundingClientRect();if(!l[i].closest('[hidden]')&&(r.width||r.height))c++;}return c;})()");
const firstId = await firstItem('artDlg');
let outside = 0;
for (let i = 0; i < total + 3; i++) {
  await key('Tab', 'Tab', 9);
  if (!(await js("document.getElementById('artDlg').contains(document.activeElement)"))) outside++;
}
push('Tab 走完整圈不跑出弹窗', outside === 0, 'outside=' + outside + ' total=' + total);
const wrap = await state('artDlg');
push('Tab 到末尾回到第一个控件', !!(wrap && wrap.inside && wrap.active === firstId), JSON.stringify(wrap) + ' first=' + firstId);
await key('Escape', 'Escape', 27);
st = await state('artDlg');
push('Esc 关闭写文章弹窗', !!(st && st.open === false));
push('关闭后焦点回到「写新文章」按钮', !!(st && st.active === 'BUTTON#artNew'), JSON.stringify(st));

// B. 命令面板
await key('k', 'KeyK', 75, 2);
st = await state('cmdk');
push('命令面板 aria-modal + 焦点在输入框', !!(st && st.open && st.modal === 'true' && st.inside && st.active === 'INPUT#ckInput'), JSON.stringify(st));
let outside2 = 0;
for (let i = 0; i < 8; i++) {
  await key('Tab', 'Tab', 9);
  if (!(await js("document.getElementById('cmdk').contains(document.activeElement)"))) outside2++;
}
push('命令面板 Tab 不跑出', outside2 === 0, 'outside=' + outside2);
await key('Escape', 'Escape', 27);
st = await state('cmdk');
push('命令面板 Esc 关闭且焦点不落 body', !!(st && st.open === false && !st.body), JSON.stringify(st));

// C. 删除确认：Esc 只关不删
const before = await js("document.querySelectorAll('#artTbody tr').length");
await click('#artTbody [data-artdel]');
st = await state('delDlg');
push('删除确认弹窗 aria-modal + 焦点在内', !!(st && st.open && st.modal === 'true' && st.inside), JSON.stringify(st));
await key('Escape', 'Escape', 27);
st = await state('delDlg');
const after = await js("document.querySelectorAll('#artTbody tr').length");
push('Esc 关闭删除确认', !!(st && st.open === false));
push('Esc 没有真的删掉文章', before === after, 'rows ' + before + ' -> ' + after);
push('删除确认关闭后焦点落在按钮上（不是 body）', !!(st && !st.body), JSON.stringify(st));

const bad = rows.filter((x) => !x).length;
console.log('\n' + (bad ? 'FAILED ' + bad + '/' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + W + 'px  ' + base);
ws.close();
proc.kill();
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(bad ? 1 : 0);