import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const PORT = 9600 + Math.floor(Math.random() * 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let id = 0; const pending = new Map();
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; break; }
  } catch {}
  await sleep(200);
}
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result && r.result.result ? r.result.result.value : null; };
const waitFor = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await js(expr)) return true; } catch {} await sleep(120); } return false; };
let pass = 0; let fail = 0;
const check = (label, ok, detail) => { if (ok) { pass += 1; console.log('OK   ' + label + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); } else { fail += 1; console.log('FAIL ' + label + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); } };

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "window.__shared=null;window.__copied=null;window.__canShare=true;\ntry{Object.defineProperty(navigator,'share',{configurable:true,get(){return window.__canShare?function(d){window.__shared=d;return Promise.resolve();}:undefined}})}catch(e){}\ntry{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(t){window.__copied=t;return Promise.resolve()}}})}catch(e){}",
});

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: BASE + '/' });
await waitFor("document.querySelectorAll('#list .item .mshare').length >= 10", 20000);
await sleep(700);

const info = await js("(function(){var b=document.querySelector('#list .item .mshare');var cs=getComputedStyle(b);var r=b.getBoundingClientRect();return {disp:cs.display,op:cs.opacity,h:Math.round(r.height),w:Math.round(r.width),aria:b.getAttribute('aria-label'),tag:b.tagName,ti:b.tabIndex,count:document.querySelectorAll('#list .item .mshare').length};})()");
check('390 上每张卡都有「分享」', info.count >= 10, info.count);
check('「分享」手机端真的显示（不是 display:none）', info.disp !== 'none' && info.op !== '0', { disp: info.disp, op: info.op });
check('触摸尺寸够（高 ≥28、宽 ≥40）', info.h >= 28 && info.w >= 40, { h: info.h, w: info.w });
check('可访问名带项目名', /^分享「.+」$/.test(info.aria || ''), info.aria);
check('是可聚焦按钮（不是 div）', info.tag === 'BUTTON' && info.ti >= 0, { tag: info.tag, ti: info.ti });

// 1) 有 navigator.share 时走系统分享
await js("document.querySelector('#list .item .mshare').click()");
await sleep(400);
const shared = await js('window.__shared');
check('点分享调起系统分享面板（带 url/title）', !!shared && /^https:\/\/github\.com\//.test(shared.url || ''), shared);
check('分享内容含项目名与星数', !!shared && /★/.test(shared.text || '') && (shared.text || '').indexOf((shared.title || 'x')) >= 0, { text: (shared.text || '').slice(0, 40) });
check('点完按钮短暂变「已分享」', await js("(function(){var b=document.querySelector('#list .item .mshare');return b.textContent;})()") === '已分享');

// 2) 没有 share 时退回复制
await js("window.__canShare = false; window.__shared = null;");
await js("document.querySelector('#list .item .mshare').click()");
await sleep(400);
const copied = await js('window.__copied');
check('没有系统分享 → 退回复制（内容含链接）', !!copied && /github\.com\//.test(copied || ''), { head: String(copied || '').slice(0, 40) });
check('退回复制后按钮变「已复制」', await js("document.querySelector('#list .item .mshare').textContent") === '已复制');

// 3) 桌面不显示（避免一排三个按钮）
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const desk = await js("(function(){var w=document.querySelector('#list .item .mshare-row'),b=document.querySelector('#list .item .mshare');var r=b?b.getBoundingClientRect():{width:0,height:0};return {row:w?getComputedStyle(w).display:null, box:[Math.round(r.width),Math.round(r.height)], count:document.querySelectorAll('#list .item .mshare').length};})()");
check('1440 上「分享」隐藏（整行 display:none、按钮占 0）', desk.row === 'none' && desk.box[1] === 0, desk);

// 4) 390 不横向溢出
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(400);
check('390 不横向溢出', await js('document.documentElement.scrollWidth === document.documentElement.clientWidth'), await js('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'));

console.log('\n' + (fail === 0 ? 'ALL OK (' + pass + ')' : 'FAILED ' + fail + ' / ' + (pass + fail)) + '  @' + BASE);
ws.close(); proc.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);