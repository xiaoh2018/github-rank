// 空正文文章：入口拒绝 + 阅读器给提示（v234）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = /^https?:/.test(BASE) && !/127\.0\.0\.1|localhost/.test(BASE);
const PW = process.env.ADMIN_PW || 'dev';
const results = [];
const check = (n, ok, extra) => { results.push(!!ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (extra === undefined || extra === '' ? '' : '  → ' + extra)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (body) => {
  const r = await fetch(BASE + '/api/articles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

// —— 写接口（本地才写，线上跳过）——
if (!REMOTE) {
  const bad = await post({ password: PW, action: 'add', article: { title: '空正文测试', body: '', summary: '只有摘要' } });
  check('空正文保存被拒（400）', bad.status === 400, JSON.stringify(bad).slice(0, 120));
  check('拒绝理由说清「正文是空的」', /正文是空的/.test((bad.j && bad.j.error) || ''), (bad.j || {}).error);

  const good = await post({ password: PW, action: 'add', article: { title: '有正文测试', body: '## 小标题\n\n一段正文。', summary: '带正文' } });
  const newId = good.j && good.j.articles ? (good.j.articles.find((a) => a.title === '有正文测试') || {}).id : null;
  check('有正文可以保存（200）', good.status === 200 && !!newId, JSON.stringify({ status: good.status, id: newId }));
  if (newId) {
    const rm = await post({ password: PW, action: 'remove', id: newId });
    check('测试文章能删掉（200）', rm.status === 200, JSON.stringify(rm.j).slice(0, 80));
  }
}

const arts = await (await fetch(BASE + '/data/articles.json')).json().catch(() => []);
check('数据里没有重复的「…1111」测试文章', !arts.some((a) => /1111\s*$/.test(String(a.title || ''))), JSON.stringify(arts.map((a) => a.title)));
const emptyArt = arts.find((a) => !String(a.body || '').trim());

// —— 前台表现 ——
const port = 9400 + Math.floor(Math.random() * 400);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, '--window-size=' + W + ',' + H, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let sock = null;
for (let i = 0; i < 40 && !sock; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); const p = l.find((t) => t.type === 'page');
    if (p) { sock = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; }); } } catch {}
  await sleep(250);
}
if (!sock) { console.error('CDP 连接失败：可能有残留 headless chrome 占着端口'); proc.kill(); process.exit(2); }
let id = 0; const pending = new Map();
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); sock.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };
await send('Page.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 760 });

if (emptyArt) {
  await send('Page.navigate', { url: BASE + '/articles/' + (emptyArt.slug || 'cat/1') + '.html' });
  await sleep(2600);
  const txt = await js("(function(){var r=document.getElementById('reader')||document.body;return r.textContent.replace(/\\s+/g,' ').trim().slice(0,300);})()");
  check('静态文章页对空正文给提示（不空白）', /这篇还没有正文/.test(txt), txt.slice(0, 80));
} else {
  check('数据里存在一篇空正文文章（用于复现）', false, '没有空正文文章，跳过前台检查');
}

await send('Page.navigate', { url: BASE + '/articles' });
await sleep(2400);
const cards = await js("document.querySelectorAll('#cards .acard').length");
check('列表卡片数 = 数据条数（删掉重复后 2 篇）', cards === arts.length, JSON.stringify({ cards, arts: arts.length }));
check('页面不横向溢出', (await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1')) === true, await js('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'));

sock.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
const failed = results.filter((r) => !r).length;
console.log('\n' + (failed ? failed + ' 项未通过 / ' + results.length : 'ALL OK (' + results.length + ')') + '  @' + W + 'px  ' + BASE);
process.exit(failed ? 1 : 0);