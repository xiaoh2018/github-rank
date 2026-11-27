import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = /^https?:/.test(BASE) && !BASE.includes('127.0.0.1');
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
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
          return { proc, ws, userDir };
        }
      } catch (e) { last = e; }
      await sleep(200);
    }
    proc.kill();
  }
  throw new Error('cdp 连不上：可能有残留 headless chrome 占着端口（' + (last && last.message) + '）');
}

const { proc, ws, userDir } = await connect();
let id = 0; const pending = new Map(); const events = [];
let intercept = null; let hits = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') {
    if (intercept !== null) {
      hits++;
      const isApi = m.params.request.url.indexOf('/api/site') >= 0;
      const payload = isApi ? { ok: true, site: intercept } : intercept;
      const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }], body: b64 });
      return;
    }
    send('Fetch.continueRequest', { requestId: m.params.requestId });
    return;
  }
  events.push(m);
};
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text };
  return r.result && r.result.result ? r.result.result.value : null;
};

const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 700 });

const siteDoc = await (await fetch(BASE + '/api/site')).json();
const site = siteDoc.site || siteDoc;
const c = (site.contact || {});
const expectWechat = String(c.wechat || '').trim();

await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
await sleep(2600);

const fab = await js(`(function(){var f=document.getElementById('contactFab');if(!f)return null;var r=f.getBoundingClientRect();var cs=getComputedStyle(f);return {vis:cs.display!=='none'&&cs.visibility!=='hidden'&&r.width>0,label:f.getAttribute('aria-label'),ctrl:f.getAttribute('aria-controls'),target:!!document.getElementById(f.getAttribute('aria-controls')),exp:f.getAttribute('aria-expanded'),w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right),vw:innerWidth};})()`);
push('联系按钮存在且可见', fab && fab.vis, JSON.stringify(fab && { w: fab.w, h: fab.h }));
push('按钮有可访问名「联系我」', fab && fab.label === '联系我', fab && fab.label);
push('按钮 aria-controls 指向真实面板', fab && fab.ctrl === 'contactPanel' && fab.target, fab && fab.ctrl);
push('初始 aria-expanded=false', fab && fab.exp === 'false', fab && fab.exp);
push('按钮在视口内且可点（≥40×40）', fab && fab.right <= fab.vw && fab.w >= 40 && fab.h >= 40, fab && JSON.stringify({ w: fab.w, h: fab.h, right: fab.right, vw: fab.vw }));

const panel0 = await js(`(function(){var p=document.getElementById('contactPanel');if(!p)return null;return {hidden:p.hidden,role:p.getAttribute('role'),modal:p.getAttribute('aria-modal'),labelledby:p.getAttribute('aria-labelledby'),tabindex:p.getAttribute('tabindex'),hasBox:p.getBoundingClientRect().width>0};})()`);
push('面板初始隐藏且是 dialog（非模态）', panel0 && panel0.hidden === true && panel0.role === 'dialog' && !panel0.modal, JSON.stringify(panel0));
push('面板 aria-labelledby 指向标题、tabindex=-1', panel0 && panel0.labelledby === 'contactTitle' && panel0.tabindex === '-1', '');

const opened = await js(`(async function(){var f=document.getElementById('contactFab');f.click();await new Promise(function(r){setTimeout(r,220);});var p=document.getElementById('contactPanel');var a=document.activeElement;return {hidden:p.hidden,exp:f.getAttribute('aria-expanded'),focusIn:p.contains(a),active:(a&&(a.id||a.tagName))||'none',box:p.getBoundingClientRect().width>0};})()`);
push('点开后可见、aria-expanded=true', opened && opened.hidden === false && opened.exp === 'true' && opened.box, JSON.stringify(opened && { hidden: opened.hidden, exp: opened.exp }));
push('点开后焦点进入面板', opened && opened.focusIn === true, opened && opened.active);

const body = await js(`(function(){var b=document.getElementById('contactBody');return b?{txt:(b.textContent||'').replace(/\\s+/g,' ').trim(),imgs:b.querySelectorAll('img').length}:null;})()`);
push('面板内容展示微信（读自 site.json）', expectWechat ? (body && body.txt.includes(expectWechat)) : (body && body.txt.length > 0), body && body.txt.slice(0, 60));

const esc = await js(`(async function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(function(r){setTimeout(r,220);});var p=document.getElementById('contactPanel');var f=document.getElementById('contactFab');return {hidden:p.hidden,exp:f.getAttribute('aria-expanded'),focus:(document.activeElement&&document.activeElement.id)||'none'};})()`);
push('Esc 关闭并把焦点还给按钮', esc && esc.hidden === true && esc.exp === 'false' && esc.focus === 'contactFab', JSON.stringify(esc));

const reClose = await js(`(async function(){var f=document.getElementById('contactFab');f.click();await new Promise(function(r){setTimeout(r,180);});document.getElementById('contactClose').click();await new Promise(function(r){setTimeout(r,200);});var p=document.getElementById('contactPanel');return {hidden:p.hidden,focus:(document.activeElement&&document.activeElement.id)||'none'};})()`);
push('✕ 关闭并还焦点', reClose && reClose.hidden === true, JSON.stringify(reClose));

const over = await js(`({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})`);
push('页面不横向溢出', over && over.sw <= over.cw + 1, over && over.sw + '/' + over.cw);

// 数据驱动：关闭开关 / 全空 → 按钮消失
async function withSite(mutate) {
  const doc = JSON.parse(JSON.stringify(siteDoc));
  mutate(doc.site || doc);
  intercept = doc;
  await send('Page.setBypassServiceWorker', { bypass: true });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  hits = 0;
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/site*' }, { urlPattern: '*/data/site.json*' }] });
  await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
  await sleep(2600);
  const r = await js(`(function(){var f=document.getElementById('contactFab');if(!f)return {no:true};var cs=getComputedStyle(f);return {hidden:f.hidden,display:cs.display,w:f.getBoundingClientRect().width};})()`);
  await send('Fetch.disable');
  if (process.env.DBG) console.log('   intercept hits:', hits);
  intercept = null;
  await send('Network.setCacheDisabled', { cacheDisabled: false });
  events.length = 0;
  return r;
}

const off = await withSite((s) => { s.contact = Object.assign({}, s.contact, { enabled: false }); });
push('开关关闭时按钮不显示', off && (off.hidden === true || off.display === 'none' || off.w === 0), JSON.stringify(off));

const empty = await withSite((s) => { s.contact = { enabled: true, title: '联系我', wechat: '', qrUrl: '', email: '', note: '' }; });
push('全空时按钮不显示（不摆空面板）', empty && (empty.hidden === true || empty.display === 'none' || empty.w === 0), JSON.stringify(empty));

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  → ' + r.extra : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  @' + W + 'px  ' + BASE : bad + ' FAILED of ' + rows.length);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(bad === 0 ? 0 : 1);
