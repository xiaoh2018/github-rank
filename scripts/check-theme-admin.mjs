import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !BASE.includes('127.0.0.1');
const PW = process.env.ADMIN_PW || 'dev';
const W = Number(process.env.W || 1440);

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  let last;
  for (let i = 0; i < 3; i++) {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
    const port = await freePort();
    const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, '--window-size=' + W + ',900', '--no-first-run', '--disable-gpu', '--lang=zh-CN', 'about:blank'], { stdio: 'ignore' });
    for (let k = 0; k < 50; k++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        const page = list.find((t) => t.type === 'page');
        if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return { proc, ws, userDir }; }
      } catch (e) { last = e; }
      await sleep(200);
    }
    proc.kill();
  }
  throw new Error('cdp 连不上：可能有残留 headless chrome 占着端口（' + (last && last.message) + '）');
}

const { proc, ws, userDir } = await connect();
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text };
  return r.result && r.result.result ? r.result.result.value : null;
};
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 700 });

const state = () => js(`(function(){var st=document.getElementById('themeState'),wrap=document.getElementById('themeClearWrap');return st?{txt:(st.textContent||'').trim(),hidden:st.hidden,wrapHidden:wrap?wrap.hidden:null,ls:(function(){try{return localStorage.getItem('ghrank:theme')}catch(e){return 'ERR'}})()}:null;})()`);

if (!REMOTE) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{sessionStorage.setItem('adminPw','" + PW + "')}catch(e){}" });
}
await send('Page.navigate', { url: BASE + '/admin?t=' + Date.now() });
await sleep(2600);

if (!REMOTE) {
  await js(`(function(){try{localStorage.removeItem('ghrank:theme')}catch(e){};var n=document.querySelector('[data-tab="theme"]');if(n)n.click();return 1;})()`);
  await sleep(400);
  const s0 = await state();
  push('主题面板有「你现在会看到什么」的状态行', s0 && s0.hidden === false && s0.txt.length > 0, s0 && s0.txt.slice(0, 50));
  push('没选过主题 → 说明会按站点默认显示', s0 && /没手动选过主题/.test(s0.txt) && /站点默认/.test(s0.txt), s0 && s0.txt.slice(0, 60));
  push('没本地主题时不显示「清除」入口', s0 && s0.wrapHidden === true, s0 && 'wrapHidden=' + s0.wrapHidden);

  const s1 = await js(`(function(){try{localStorage.setItem('ghrank:theme','ink')}catch(e){};var n=document.querySelector('[data-tab="theme"]');if(n)n.click();return 1;})()`);
  await sleep(400);
  const s2 = await state();
  push('本地存了「冷暗」→ 说明前台会显示它、而不是站点默认', s2 && /Linear 冷暗/.test(s2.txt) && /而不是站点默认/.test(s2.txt), s2 && s2.txt.slice(0, 70));
  push('有本地主题时给出清除入口', s2 && s2.wrapHidden === false, s2 && 'wrapHidden=' + s2.wrapHidden);

  const cleared = await js(`(async function(){var b=document.getElementById('themeClearLocal');if(!b)return {no:true};b.click();await new Promise(function(r){setTimeout(r,150)});var st=document.getElementById('themeState');var wrap=document.getElementById('themeClearWrap');return {txt:(st.textContent||'').trim(),wrapHidden:wrap.hidden,ls:(function(){try{return localStorage.getItem('ghrank:theme')}catch(e){return 'ERR'}})(),btn:(b.textContent||'').trim()};})()`);
  push('点「清除」后本地主题被删、文案回到站点默认', cleared && cleared.ls === null && /没手动选过主题/.test(cleared.txt) && cleared.wrapHidden === true, cleared && JSON.stringify({ ls: cleared.ls, wrapHidden: cleared.wrapHidden }));
  push('清除后按钮给出确认文案', cleared && /已清除/.test(cleared.btn), cleared && cleared.btn);

  const offUser = await js(`(function(){var a=document.getElementById('theme-allow');a.checked=false;a.dispatchEvent(new Event('change',{bubbles:true}));var st=document.getElementById('themeState');return (st.textContent||'').trim();})()`);
  push('关掉「允许访客切换」→ 说明前台一律用站点默认', /已关/.test(offUser) && /忽略/.test(offUser), offUser.slice(0, 70));

  const backOn = await js(`(function(){var a=document.getElementById('theme-allow');a.checked=true;a.dispatchEvent(new Event('change',{bubbles:true}));var st=document.getElementById('themeState');return (st.textContent||'').trim();})()`);
  push('重新打开开关 → 文案恢复', /没手动选过主题/.test(backOn) || /站点默认/.test(backOn), backOn.slice(0, 60));

  const over = await js(`({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})`);
  push('后台页面不横向溢出', over && over.sw <= over.cw + 1, over && over.sw + '/' + over.cw);
} else {
  push('线上模式：跳过后台断言（需要后台密码）', true, 'REMOTE');
}

// 前台：本地主题优先于站点默认
await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
await sleep(2400);
const frontInk = await js(`(async function(){try{localStorage.setItem('ghrank:theme','ink')}catch(e){};location.reload();return 1;})()`);
await sleep(2400);
const t1 = await js(`document.documentElement.getAttribute('data-theme')`);
push('前台：本地选了冷暗 → 页面就是冷暗', t1 === 'ink', t1);

await js(`(function(){try{localStorage.removeItem('ghrank:theme')}catch(e){};location.reload();return 1;})()`);
await sleep(2400);
const t2 = await js(`document.documentElement.getAttribute('data-theme')`);
push('前台：清除后回到站点默认主题', t2 && t2 !== 'ink', t2);

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  → ' + r.extra : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  @' + W + 'px  ' + BASE : bad + ' FAILED of ' + rows.length);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(bad === 0 ? 0 : 1);
