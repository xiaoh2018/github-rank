// 文章列表翻页：往前回列表顶、往回恢复上次位置（v230）
// 用 CDP 拦截 /data/articles.json 伪造 45 篇，不写磁盘数据
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const BASE = 'http://127.0.0.1:8123';
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra === undefined || extra === '' ? '' : '  → ' + extra)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9500 + Math.floor(Math.random() * 300);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, '--window-size=' + W + ',' + H, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; break; }
  } catch {}
  await sleep(200);
}
const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
const js = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };

await send('Page.enable'); await send('Network.enable'); await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 760 });
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Fetch.enable', { patterns: [{ urlPattern: '*/data/articles.json*' }] });
const arts = [];
for (let i = 1; i <= 45; i++) arts.push({ id: 'tmp-' + i, title: '临时文章 ' + i, summary: '摘要 ' + i, body: '## 小节\n\n正文 ' + i, category: i % 2 ? 'tech' : '', date: '2026-11-' + String((i % 28) + 1).padStart(2, '0'), slug: 'tmp-' + i + '-a', createdAt: '2026-11-01T00:00:00Z' });
const fake = Buffer.from(JSON.stringify(arts)).toString('base64');
ws.addEventListener('message', async (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') {
    const rid = m.params.requestId;
    if (m.params.request.url.includes('/data/articles.json')) await send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: fake });
    else await send('Fetch.continueRequest', { requestId: rid });
  }
});

await send('Page.navigate', { url: BASE + '/articles' });
await sleep(2200);

const st = () => js(`(function(){var p=document.getElementById('apager');var c=document.getElementById('cards');return {cards:c.querySelectorAll('.acard').length||c.querySelectorAll('.acard').length, txt:p?p.textContent.replace(/\\s+/g,' ').trim():'', pagerHidden:p?p.hidden:null, y:Math.round(window.scrollY), cardsTop:Math.round(c.getBoundingClientRect().top+window.scrollY), cols:getComputedStyle(c).gridTemplateColumns.split(' ').length};})()`);
const clickPg = (dir) => js(`(function(){var bs=document.querySelectorAll('#apager button[data-page]');var b=bs[${dir === 'next' ? 'bs.length-1' : '0'}];if(!b||b.disabled)return 'disabled';b.click();return 'ok';})()`);

const s1 = await st();
check('首页 9 张卡（每页 9 篇）', s1.cards === 9, JSON.stringify({ cards: s1.cards }));
check('分页文案对（第 1 / 5 页 · 共 45 篇）', /第 1 \/ 5 页/.test(s1.txt) && /共 45 篇/.test(s1.txt), s1.txt);

await js('window.scrollTo(0, 420)'); await sleep(250);
const yLeave = await js('Math.round(window.scrollY)');
check('离开第 1 页前真的滚下去了（>100，且不等于列表顶）', yLeave > 100, JSON.stringify({ yLeave }));
check('往前翻：点下一页', (await clickPg('next')) === 'ok');
await sleep(700);
const s2 = await st();
check('往前翻后回到列表顶（±40px）', Math.abs(s2.y - (s2.cardsTop - 96)) <= 40, JSON.stringify({ y: s2.y, want: s2.cardsTop - 96 }));
check('确实到了第 2 页', /第 2 \/ 5 页/.test(s2.txt), s2.txt);

// 关键区分：先回到第 2 页顶部，再往回翻 —— 若没有记忆会停在列表顶，有记忆应回到 yLeave
await js('window.scrollTo(0, 0)'); await sleep(200);
check('往回翻：点上一页', (await clickPg('prev')) === 'ok');
await sleep(750);
const s3 = await st();
check('往回翻恢复第 1 页离开时的位置（±25px，不是列表顶）', Math.abs(s3.y - yLeave) <= 25 && s3.y > 300, JSON.stringify({ y: s3.y, yLeave }));
check('回到第 1 页', /第 1 \/ 5 页/.test(s3.txt), s3.txt);
check('记忆键存在且指向离开位置', (await js(`(function(){var k=Object.keys(window.__apY||{});return k.length?window.__apY[k[0]]:0;})()`)) === yLeave, yLeave);

check('再往前翻一次', (await clickPg('next')) === 'ok');
await sleep(700);
const s4 = await st();
check('前翻仍回列表顶（不复用旧位置）', Math.abs(s4.y - (s4.cardsTop - 96)) <= 40, JSON.stringify({ y: s4.y, want: s4.cardsTop - 96 }));

await js(`(function(){var i=document.getElementById('search');i.value='临时文章 44';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(500);
const s5 = await st();
check('搜索后结果 1 篇且分页收起', s5.cards === 1 && s5.pagerHidden === true, JSON.stringify({ cards: s5.cards, hidden: s5.pagerHidden }));

check('页面不横向溢出', (await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1')) === true, await js('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'));

const failed = results.filter((r) => !r.ok);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
console.log('\n' + (failed.length ? failed.length + ' 项未通过 / ' + results.length : 'ALL OK (' + results.length + ')') + '  @' + W + 'px  ' + BASE);
process.exit(failed.length ? 1 : 0);