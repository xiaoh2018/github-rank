// 友链：占位数据清理 + 写接口占位拦截 + 前台空态/列表态
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const REMOTE = !!process.env.PROBE_BASE;
const PW = process.env.ADMIN_PW || 'dev';
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra === undefined ? '' : '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (body) => fetch(BASE + '/api/links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// --- HTTP 层 ---
const g0 = await (await fetch(BASE + '/api/links')).json();
check('GET /api/links 是数组', Array.isArray(g0.links), g0.links && g0.links.length);
check('当前没有占位友链（「123」已清）', Array.isArray(g0.links) && !g0.links.some((l) => /^\d+$/.test(String(l && l.name || '').trim())), JSON.stringify(g0.links));

if (!REMOTE) {
  // 先把历史遗留（含刚才那次测试）清干净，保证起点是空列表
  const before = (await (await fetch(BASE + '/api/links')).json()).links || [];
  for (let i = before.length - 1; i >= 0; i--) await post({ password: PW, action: 'remove', index: i });
  const clean = (await (await fetch(BASE + '/api/links')).json()).links || [];
  check('清理后是空列表', clean.length === 0, clean.length);

  const bad1 = await post({ password: PW, action: 'add', name: '123', url: 'https://example.com/' });
  check('写接口拒绝占位名「123」（400 + 说明）', bad1.status === 400 && /占位/.test(String(bad1.body && bad1.body.error || '')), bad1.body && bad1.body.error);
  const bad2 = await post({ password: PW, action: 'add', name: 'test', url: 'https://example.com/' });
  check('写接口拒绝「test」', bad2.status === 400, bad2.body && bad2.body.error);
  const okAdd = await post({ password: PW, action: 'add', name: '小明的博客', url: 'https://example.com/' });
  check('真名字能加上', okAdd.status === 200 && Array.isArray(okAdd.body.links) && okAdd.body.links.length === 1, okAdd.status);
  const del = await post({ password: PW, action: 'remove', index: 0 });
  check('删掉后回到空列表', del.status === 200 && Array.isArray(del.body.links) && del.body.links.length === 0, del.status);
}

// --- 浏览器层 ---
const port = 9500 + Math.floor(Math.random() * 300);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, '--window-size=' + W + ',' + H, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
async function connect(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = l.find((t) => t.type === 'page');
      if (p) {
        const sock = new WebSocket(p.webSocketDebuggerUrl);
        await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
        return sock;
      }
    } catch {}
    await sleep(250);
  }
  return null;
}
for (let attempt = 0; attempt < 3 && !ws; attempt++) {
  if (attempt) await sleep(800);
  const sock = await connect(port + attempt * 7);
  if (sock) { ws = sock; ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; }
}
if (!ws) { console.error('CDP 连接失败：可能有残留 headless chrome 占着端口，先清掉再跑'); proc.kill(); process.exit(2); }
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };
await send('Page.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 760 });
await send('Network.setCacheDisabled', { cacheDisabled: true });

const cardState = () => js(`(function(){var b=document.getElementById('friendLinks');var as=b?b.querySelectorAll('#friendList a'):[];var out=[];for(var i=0;i<as.length;i++){out.push({t:as[i].textContent, target:as[i].target, rel:as[i].rel, href:as[i].getAttribute('href')});}return {hidden:b?b.hidden:null, n:as.length, items:out};})()`);

// 1) 真实情况：空数组 → 卡片隐藏
await send('Page.navigate', { url: BASE + '/' });
await sleep(2200);
const real = await cardState();
check('没有友链时整块卡片隐藏（不渲染空卡片）', real.hidden === true && real.n === 0, real);

// 2) 伪造两条友链 → 卡片显示、链接带 _blank + noopener
await send('Fetch.enable', { patterns: [{ urlPattern: '*/data/links.json*' }] });
const fake = Buffer.from(JSON.stringify([{ name: '小明的博客', url: 'https://example.com/a', desc: '写前端' }, { name: '另一个站', url: 'https://example.org/b' }])).toString('base64');
ws.addEventListener('message', async (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') {
    const rid = m.params.requestId;
    if (m.params.request.url.includes('/data/links.json')) await send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: fake });
    else await send('Fetch.continueRequest', { requestId: rid });
  }
});
await send('Page.navigate', { url: BASE + '/' });
await sleep(2200);
const withLinks = await cardState();
check('有友链时卡片显示 2 条', withLinks.hidden === false && withLinks.n === 2, withLinks);
check('友链都在新标签打开（target=_blank）', withLinks.items.every((it) => it.target === '_blank'), withLinks.items.map((i) => i.target));
check('友链带 rel=noopener', withLinks.items.every((it) => /noopener/.test(it.rel || '')), withLinks.items.map((i) => i.rel));
check('友链文字用站点名（不是裸网址）', withLinks.items[0].t === '小明的博客', withLinks.items[0].t);
check('页面不横向溢出', (await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1')) === true, await js('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'));

const failed = results.filter((r) => !r.ok);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
console.log('\n' + (failed.length ? failed.length + ' 项未通过 / ' + results.length : 'ALL OK (' + results.length + ')') + '  @' + W + 'px  ' + BASE);
process.exit(failed.length ? 1 : 0);