import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !BASE.includes('127.0.0.1');
const W = Number(process.env.W || 1440);
const PW = process.env.ADMIN_PW || 'dev';

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
let mode = 'double'; let hits = 0;
const siteRaw = (() => { try { return JSON.parse(fs.readFileSync('data/site.json', 'utf8')); } catch { return {}; } })();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    const u = request.url;
    if (/\/api\/site|\/data\/site\.json/.test(u)) {
      hits++;
      const site = JSON.parse(JSON.stringify(siteRaw));
      site.article = Object.assign({}, site.article, { cols: mode });
      const isApi = u.includes('/api/');
      const body = JSON.stringify(isApi ? { ok: true, site } : site);
      ws.send(JSON.stringify({ id: ++id, method: 'Fetch.fulfillRequest', params: { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: isApi ? 'application/json' : 'application/json; charset=utf-8' }], body: Buffer.from(body).toString('base64') } }));
    } else ws.send(JSON.stringify({ id: ++id, method: 'Fetch.continueRequest', params: { requestId } }));
  }
};
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 700 });
await send('Fetch.enable', { patterns: [{ urlPattern: '*site*' }] });

const measure = async (page, sel) => {
  await send('Page.navigate', { url: BASE + page + '?t=' + Date.now() + '&m=' + mode });
  await sleep(2500);
  return js(`(function(){var el=document.querySelector('${sel}');if(!el)return {no:1};var cs=getComputedStyle(el);var g=cs.gridTemplateColumns||'';var isGrid=cs.display.indexOf('grid')>=0;return {attr:document.documentElement.getAttribute('data-artcols'),display:cs.display,g:g,cols:isGrid?g.split(' ').filter(Boolean).length:1};})()`);
};

const homeCols = {}; const artCols = {};
for (const m of ['single', 'double', 'triple', 'auto']) {
  mode = m;
  const h = await measure('/', '.artgrid');
  const a = await measure('/articles', '.cards');
  homeCols[m] = h; artCols[m] = a;
  push('两页都落到 html[data-artcols=' + m + ']', h && h.attr === m && a && a.attr === m, (h && h.attr) + '/' + (a && a.attr));
}
if (W < 760) {
  push('窄屏：四档在两页都是单列（手机不看设置）', ['single', 'double', 'triple', 'auto'].every(function (k) { return homeCols[k].cols === 1 && artCols[k].cols === 1; }), ['single', 'double', 'triple', 'auto'].map(function (k) { return k + '=' + homeCols[k].cols + '/' + artCols[k].cols; }).join(' '));
} else {
  push('单列：首页 1 列、文章页 1 列', homeCols.single.cols === 1 && artCols.single.cols === 1, homeCols.single.cols + '/' + artCols.single.cols);
  push('双列：首页 2 列、文章页 2 列', homeCols.double.cols === 2 && artCols.double.cols === 2, homeCols.double.cols + '/' + artCols.double.cols);
  push('三列：' + (W >= 1100 ? '两页都 3 列' : '窄屏降为 ≤2 列'), W >= 1100 ? homeCols.triple.cols === 3 && artCols.triple.cols === 3 : homeCols.triple.cols <= 2 && artCols.triple.cols <= 2, homeCols.triple.cols + '/' + artCols.triple.cols);
  push('自动：两页都按容器铺满（≥1 列）', homeCols.auto.cols >= 1 && artCols.auto.cols >= 1, homeCols.auto.cols + '/' + artCols.auto.cols);
}

const src = (() => {
  try {
    const a = fs.readFileSync('index.html', 'utf8');
    const b = fs.readFileSync('articles.html', 'utf8');
    return { h: /minmax\(320px,1fr\)/.test(a), a: /minmax\(320px,1fr\)/.test(b), body: /body\[data-artcols/.test(a) };
  } catch (e) { return null; }
})();
push('两页「自动」的最小列宽一致（320px）', src && src.h && src.a, src && JSON.stringify(src));
push('首页不再只给 body 挂属性（html 也能命中）', src && src.body === false, src && 'bodySelectors=' + src.body);

if (!REMOTE) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{sessionStorage.setItem('adminPw','" + PW + "')}catch(e){}" });
  await send('Page.navigate', { url: BASE + '/admin?t=' + Date.now() });
  await sleep(2600);
  await js(`(function(){var n=document.querySelector('[data-tab="articles"]');if(n)n.click();return 1;})()`);
  await sleep(500);
  const hint = await js(`(function(){var el=document.querySelector('#pane-articles .hint');return el?(el.textContent||'').trim():'';})()`);
  push('后台说明讲清「自动」由宽度决定、两页可能不同', /列数由页面宽度决定/.test(hint) && /可能不同/.test(hint), hint.slice(0, 80));
  const over = await js(`({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})`);
  push('后台不横向溢出', over && over.sw <= over.cw + 1, over && over.sw + '/' + over.cw);
} else {
  push('线上模式：跳过后台断言（需要后台密码）', true, 'REMOTE');
}
push('拦截确实命中（否则上面的断言全是空转）', hits > 0, 'hits=' + hits);

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  → ' + r.extra : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  @' + W + 'px  ' + BASE : bad + ' FAILED of ' + rows.length);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(bad === 0 ? 0 : 1);
