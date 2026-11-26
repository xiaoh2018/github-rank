// 门禁：对话框无障碍（aria-modal / 初始焦点 / Tab 不跑出 / Esc 关闭 / 关闭还焦点）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9400 + Math.floor(Math.random() * 150);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-dlga11y-'));
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
  if (r.result && r.result.exceptionDetails) return 'EXC ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
  return r.result && r.result.result ? r.result.result.value : undefined;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

async function tab(n = 1, shift = false) {
  for (let i = 0; i < n; i++) {
    const mods = shift ? 8 : 0;
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: mods });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: mods });
    await sleep(70);
  }
}
async function esc() {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}
const activeIn = (id) => ev(`(function(){var a=document.activeElement;var d=document.getElementById('${id}');return !!(a&&d&&(d.contains(a)||a===d));})()`);
const activeDesc = () => ev(`(function(){var a=document.activeElement;return a? (a.tagName+'#'+(a.id||'')+'.'+(a.className||'')) : 'none';})()`);

const rows = [];
const push = (name, ok, extra = '') => rows.push({ name, ok: !!ok, extra });

// ---- A. 首页文章弹窗（深链直接打开）----
await send('Page.navigate', { url: BASE + '/?page=articles&post=tech/4&a=' + Date.now() });
await sleep(2600);
push('[文章弹窗] 打开且有 aria-modal', await ev(`(function(){var d=document.getElementById('artDlg');return !!(d&&d.open)&&d.getAttribute('aria-modal')==='true';})()`));
push('[文章弹窗] 打开后焦点在弹窗内', await activeIn('artDlg'), await activeDesc());
let allIn = true;
for (let i = 0; i < 10; i++) { await tab(1); if (!(await activeIn('artDlg'))) { allIn = false; break; } }
push('[文章弹窗] 连按 10 次 Tab 焦点不跑出弹窗', allIn, await activeDesc());
await esc(); await sleep(350);
push('[文章弹窗] Esc 关得掉', !(await ev(`(document.getElementById('artDlg')||{}).open`)));
push('[文章弹窗] 关闭后焦点有落点（不是 body）', await ev(`document.activeElement && document.activeElement!==document.body`), await activeDesc());

// ---- B. 关于本站（按钮打开 → Esc 关闭 → 焦点归位）----
await send('Page.navigate', { url: BASE + '/?b=' + Date.now() });
await sleep(2400);
await ev(`(function(){var b=[...document.querySelectorAll('button,a')].find(x=>/关于本站/.test(x.textContent)); b&&b.focus(); b&&b.click(); return 1;})()`);
await sleep(500);
push('[关于本站] 打开且有 aria-modal', await ev(`(function(){var d=document.getElementById('aboutDialog');return !!(d&&d.open)&&d.getAttribute('aria-modal')==='true';})()`));
push('[关于本站] 打开后焦点在弹窗内', await activeIn('aboutDialog'), await activeDesc());
let in2 = true;
for (let i = 0; i < 6; i++) { await tab(1); if (!(await activeIn('aboutDialog'))) { in2 = false; break; } }
push('[关于本站] 连按 6 次 Tab 焦点不跑出', in2, await activeDesc());
await esc(); await sleep(350);
push('[关于本站] Esc 关得掉', !(await ev(`(document.getElementById('aboutDialog')||{}).open`)));
push('[关于本站] 关闭后焦点回到「关于本站」按钮', await ev(`document.activeElement && document.activeElement.id==='btnAbout'`), await activeDesc());

// ---- C. 文章页密码弹窗 ----
await send('Page.navigate', { url: BASE + '/articles/cat/1.html?c=' + Date.now() });
await sleep(2600);
await ev(`(function(){var d=document.getElementById('pwDlg'); if(!d) return 'no-dlg'; var b=document.querySelector('[data-unlock], #pwGo'); if(b){b.focus();b.click();} if(!d.open){ try{ d.showModal(); }catch(e){} } return d.open?'ok':'closed';})()`);
await sleep(500);
push('[密码弹窗] 打开且有 aria-modal', await ev(`(function(){var d=document.getElementById('pwDlg');return !!(d&&d.open)&&d.getAttribute('aria-modal')==='true';})()`), await ev(`(function(){var d=document.getElementById('pwDlg');return d?(d.open+'/'+d.getAttribute('aria-modal')):'no-dlg';})()`));
push('[密码弹窗] 打开后焦点在弹窗内', await activeIn('pwDlg'), await activeDesc());
let in3 = true;
for (let i = 0; i < 6; i++) { await tab(1); if (!(await activeIn('pwDlg'))) { in3 = false; break; } }
push('[密码弹窗] 连按 6 次 Tab 焦点不跑出', in3, await activeDesc());

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
ws.close(); child.kill(); await sleep(150);
process.exit(bad === 0 ? 0 : 1);
