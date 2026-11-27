// 后台文章列表分页：换页回表格顶 / 往回翻恢复位置 / 跳到第 N 页（v231）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PW || 'dev';
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra === undefined || extra === '' ? '' : '  → ' + extra)); };
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

await send('Page.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 760 });
await send('Network.setCacheDisabled', { cacheDisabled: true });

const arts = [];
for (let i = 1; i <= 45; i++) {
  arts.push({ id: 'tmp-' + i, title: '临时文章 ' + i, summary: '摘要 ' + i, body: '## 小节\n\n正文 ' + i, category: i % 2 ? 'tech' : '', date: '2026-11-' + String((i % 28) + 1).padStart(2, '0'), slug: 'tmp-' + i + '-a', prevCount: 0 });
}
const fake = Buffer.from(JSON.stringify({ ok: true, articles: arts })).toString('base64');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/articles*' }] });
ws.addEventListener('message', async (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') {
    const rid = m.params.requestId;
    const u = m.params.request.url;
    if (/\/(api)\/articles/.test(u) && m.params.request.method === 'GET') await send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: fake });
    else await send('Fetch.continueRequest', { requestId: rid });
  }
});

await send('Page.navigate', { url: BASE + '/admin' });
await sleep(1500);
await js("sessionStorage.setItem('adminPw', " + JSON.stringify(PW) + ")");
await send('Page.reload', { ignoreCache: true });
await sleep(2500);
check('后台已进入（登录门消失）', (await js("document.getElementById('gate').hidden")) === true);
await js("(function(){var n=document.querySelector('.side .nav[data-tab=\"articles\"]')||document.querySelector('.side .nav');if(n)n.click();})()");
await sleep(1200);
check('文章面板可见', (await js("(function(){var p=document.getElementById('pane-articles');return !!p && getComputedStyle(p).display!=='none';})()")) === true);

const st = () => js(`(function(){var tb=document.getElementById('artTbody');var pg=document.getElementById('artPager');var rows=tb?tb.querySelectorAll('tr').length:0;var inp=document.getElementById('artJump');var card=tb&&tb.closest?tb.closest('.card'):null;var r=card?card.getBoundingClientRect():{top:-1};var fr=tb&&tb.querySelector('tr');return {rows:rows, txt:pg?pg.textContent.replace(/\\s+/g,' ').trim():'', hidden:pg?pg.hidden:null, jump:!!inp, jumpVal:inp?inp.value:null, y:Math.round(window.scrollY), top:Math.round(r.top), first:fr?Math.round(fr.getBoundingClientRect().top):-1};})()`);
const s1 = await st();
check('第一页 20 行', s1.rows === 20, JSON.stringify({ rows: s1.rows }));
check('分页文案「第 1 / 3 页 · 共 45 篇」', /第 1 \/ 3 页/.test(s1.txt) && /共 45 篇/.test(s1.txt), s1.txt);
check('有「跳到第 N 页」输入', s1.jump === true && s1.jumpVal === '1', JSON.stringify({ jump: s1.jump, v: s1.jumpVal }));

await js('window.scrollTo(0, document.documentElement.scrollHeight)'); await sleep(400);
await js("(function(){var b=document.querySelector('#artPager [data-artpage=\"next\"]');if(b&&!b.disabled)b.click();})()");
await sleep(900);
const s2 = await st();
check('换页后表格回到视口内（card.top 0–160）', s2.top >= 0 && s2.top <= 160, JSON.stringify({ top: s2.top, y: s2.y }));
check('换页后第一行也在视口内（不是停在表格底部）', s2.first >= 0 && s2.first <= 200, JSON.stringify({ first: s2.first }));
check('到了第 2 页', /第 2 \/ 3 页/.test(s2.txt), s2.txt);
if (W <= 760) {
  const pg = await js(`(function(){var bs=document.querySelectorAll('#artPager button');var hs=[];for(var i=0;i<bs.length;i++){hs.push(Math.round(bs[i].getBoundingClientRect().height));}var m=document.querySelector('#artPager .msg');return {hs:hs, msgH:m?Math.round(m.getBoundingClientRect().height):0};})()`);
  check('窄屏分页按钮单行（高 ≤ 52，没有折成两行）', pg.hs.length >= 2 && pg.hs.every((h) => h <= 52), JSON.stringify(pg.hs));
  check('窄屏页码文案不挤成两行（高 ≤ 44）', pg.msgH > 0 && pg.msgH <= 44, JSON.stringify({ msgH: pg.msgH }));
}

check('跳页输入跟随当前页', s2.jumpVal === '2', s2.jumpVal);

await js('window.scrollTo(0, document.documentElement.scrollHeight)'); await sleep(400);
const y2 = await js('Math.round(window.scrollY)');
await js("(function(){var b=document.querySelector('#artPager [data-artpage=\"prev\"]');if(b&&!b.disabled)b.click();})()");
await sleep(900);
const s3 = await st();
check('往回翻回到第 1 页', /第 1 \/ 3 页/.test(s3.txt), s3.txt);
check('往回翻恢复上次位置（不是表格顶）', s3.y > s3.top + 120 && Math.abs(s3.y - y2) <= 260, JSON.stringify({ y: s3.y, y2, top: s3.top }));

await js("(function(){var i=document.getElementById('artJump');i.value='3';i.dispatchEvent(new Event('change',{bubbles:true}));})()");
await js("(function(){var b=document.querySelector('#artPager [data-artjump]');if(b)b.click();})()");
await sleep(800);
const s4 = await st();
check('跳到第 3 页：5 行', s4.rows === 5, JSON.stringify({ rows: s4.rows }));
check('跳页后文案「第 3 / 3 页」', /第 3 \/ 3 页/.test(s4.txt), s4.txt);

await js("(function(){var i=document.getElementById('artJump');i.value='99';})()");
await js("(function(){var b=document.querySelector('#artPager [data-artjump]');if(b)b.click();})()");
await sleep(700);
check('越界输入 99 夹到最后一页（仍 3）', /第 3 \/ 3 页/.test((await st()).txt) === true, (await st()).txt);
await js("(function(){var i=document.getElementById('artJump');i.value='0';})()");
await js("(function(){var b=document.querySelector('#artPager [data-artjump]');if(b)b.click();})()");
await sleep(700);
check('输入 0 夹到第 1 页', /第 1 \/ 3 页/.test((await st()).txt) === true, (await st()).txt);

await js("(function(){var i=document.getElementById('artSearch');i.value='临时文章 4';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
await sleep(600);
const s5 = await st();
check('搜索后分页收起（结果只在 1 页）', s5.hidden === true, JSON.stringify({ hidden: s5.hidden, rows: s5.rows }));

check('页面不横向溢出', (await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1')) === true, await js('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'));

const failed = results.filter((r) => !r.ok);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
console.log('\n' + (failed.length ? failed.length + ' 项未通过 / ' + results.length : 'ALL OK (' + results.length + ')') + '  @' + W + 'px  ' + BASE);
process.exit(failed.length ? 1 : 0);