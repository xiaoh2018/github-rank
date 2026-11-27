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
let id = 0; const pending = new Map(); let paused = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') paused.push(m.params);
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
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.setBypassServiceWorker', { bypass: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 700 });

// ---------- 后台：边填边说明 ----------
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{sessionStorage.setItem('adminPw','" + PW + "')}catch(e){}" });
await send('Page.navigate', { url: BASE + '/admin?t=' + Date.now() });
await sleep(2600);

const init = await js(`(function(){var st=document.getElementById('beianState');var en=document.getElementById('beian-enabled');return st?{txt:(st.textContent||'').trim(),hidden:st.hidden,cls:st.className,en:en?en.checked:null}:null;})()`);
push('后台备案面板有状态行', init && init.hidden === false && init.txt.length > 0, init && init.txt.slice(0, 40));
push('开关关闭时说明「现在页脚不显示」', init && /现在页脚不显示/.test(init.txt), init && init.txt.slice(0, 40));

const onEmpty = await js(`(function(){var en=document.getElementById('beian-enabled');en.checked=true;en.dispatchEvent(new Event('change',{bubbles:true}));var st=document.getElementById('beianState');return {txt:(st.textContent||'').trim(),cls:st.className};})()`);
push('开开关但没填 → 提醒页脚仍不显示', onEmpty && /一条都没填/.test(onEmpty.txt) && /bad/.test(onEmpty.cls), onEmpty && onEmpty.txt.slice(0, 40));

const onFilled = await js(`(function(){var i=document.getElementById('beian-icp');i.value='京ICP备12345678号';i.dispatchEvent(new Event('input',{bubbles:true}));var st=document.getElementById('beianState');return {txt:(st.textContent||'').trim(),cls:st.className};})()`);
push('填了 ICP → 说明页脚会显示什么', onFilled && /页脚会显示：ICP备案号：京ICP备12345678号/.test(onFilled.txt) && !/bad/.test(onFilled.cls), onFilled && onFilled.txt.slice(0, 50));

const over = await js(`({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})`);
push('后台页面不横向溢出', over && over.sw <= over.cw + 1, over && over.sw + '/' + over.cw);

// ---------- 前台：三种数据各渲染一次 ----------
const site = await (await fetch(BASE + '/api/site')).json();
async function frontWith(beian) {
  const next = JSON.parse(JSON.stringify(site));
  next.beian = beian;
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/site*' }, { urlPattern: '*/data/site.json*' }] });
  await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
  let hits = 0;
  for (let k = 0; k < 60; k++) {
    await sleep(60);
    const list = paused.splice(0);
    for (const ev of list) {
      hits++;
      const isApi = /\/api\/site/.test(ev.request.url);
      const payload = isApi ? { ok: true, site: next } : next;
      await send('Fetch.fulfillRequest', {
        requestId: ev.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }],
        body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
      });
    }
    const ready = await js(`(function(){var f=document.getElementById('siteFooter');return f?{hidden:f.hidden,txt:(f.textContent||'').replace(/\\s+/g,' ').trim()}:null;})()`);
    if (ready && hits > 0 && ready.txt !== undefined) { /* fallthrough */ }
    if (k > 20) break;
  }
  await sleep(900);
  const r = await js(`(function(){var f=document.getElementById('siteFooter');if(!f)return null;var a=f.querySelector('a');return {hidden:f.hidden,txt:(f.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90),link:a?{href:a.getAttribute('href'),text:(a.textContent||'').trim(),target:a.getAttribute('target'),rel:a.getAttribute('rel')}:null,sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth};})()`);
  await send('Fetch.disable');
  paused = [];
  return { hits, ...r };
}

const shown = await frontWith({ enabled: true, icp: '京ICP备12345678号', icpUrl: 'https://beian.miit.gov.cn/', police: '', policeUrl: '', text: '' });
push('开启+有 ICP → 页脚出现并显示备案号', shown && shown.hidden === false && /京ICP备12345678号/.test(shown.txt), shown && shown.txt);
push('备案号是外链且带 noopener', shown && shown.link && shown.link.target === '_blank' && /noopener/.test(shown.link.rel || ''), shown && JSON.stringify(shown.link));
push('前台拦截确实生效（不是旧数据）', shown && shown.hits > 0, shown && 'hits=' + shown.hits);
push('前台不横向溢出', shown && shown.sw <= shown.cw + 1, shown && shown.sw + '/' + shown.cw);

const empty = await frontWith({ enabled: true, icp: '', icpUrl: 'https://beian.miit.gov.cn/', police: '', policeUrl: '', text: '' });
push('开启但全空 → 页脚不出现', empty && empty.hidden === true, empty && JSON.stringify({ hidden: empty.hidden, txt: empty.txt }));

const off = await frontWith({ enabled: false, icp: '京ICP备12345678号', icpUrl: 'https://beian.miit.gov.cn/', police: '', policeUrl: '', text: '' });
push('关闭开关但填了号 → 页脚仍不出现', off && off.hidden === true, off && JSON.stringify({ hidden: off.hidden }));

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  → ' + r.extra : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  @' + W + 'px  ' + BASE : bad + ' FAILED of ' + rows.length);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(bad === 0 ? 0 : 1);
