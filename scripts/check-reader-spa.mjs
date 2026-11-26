import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const PORT = 10600 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();
async function connect() { for (let i = 0; i < 100; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; return; } } catch (e) {} await sleep(200); } throw new Error('CDP'); }
const send = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p })); }); };
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 160); return r.result && r.result.value; };
const waitFor = async (x, ms = 25000) => { for (let t = 0; t < ms; t += 150) { try { if (await ev(x)) return true; } catch (e) {} await sleep(150); } return false; };
const rows = [];
const chk = (n, ok, extra) => rows.push({ n, ok: !!ok, extra: extra === undefined ? '' : JSON.stringify(extra) });

await connect(); await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });

await send('Page.navigate', { url: BASE + '/?page=articles&t=' + Date.now() });
await waitFor("document.querySelectorAll('#artViewList .artcard').length>0");
await sleep(600);
chk('文章视图有卡片', (await ev("document.querySelectorAll('#artViewList .artcard').length")) > 0);
chk('卡片链接带 data-artpost', await ev("!!document.querySelector('#artViewList .artcard [data-artpost]')"));
chk('链接不再是 /articles/...html', !(await ev("document.querySelector('#artViewList .artcard a').getAttribute('href')")).includes('.html'), await ev("document.querySelector('#artViewList .artcard a').getAttribute('href')"));

const nav0 = await ev("(function(){var s=window.__navCount||0;window.__navCount=0;return 1;})()");
await ev("(function(){var l=document.querySelector('#artViewList .artcard [data-artpost]');l.click();return 1;})()");
await sleep(900);
chk('点击后阅读器打开（无整页跳转）', await ev("document.getElementById('artDlg').open === true"));
chk('地址栏带上 post', /[?&]post=/.test(await ev('location.search')), await ev('location.search'));
chk('正文有内容或明确说明为空', ((await ev("document.getElementById('artDlgBody').innerText")) || '').trim().length > 0);
chk('标题非空', ((await ev("document.getElementById('artDlgT').textContent")) || '').length > 0, await ev("document.getElementById('artDlgT').textContent"));
chk('元信息有日期', /20\d\d-\d\d-\d\d/.test((await ev("document.getElementById('artDlgMeta').textContent")) || ''), await ev("document.getElementById('artDlgMeta').textContent"));

await ev("document.getElementById('artDlgX').click()");
await sleep(700);
chk('点 × 关闭', (await ev("document.getElementById('artDlg').open")) === false);
chk('关闭后地址里没有 post', !/[?&]post=/.test(await ev('location.search')), await ev('location.search'));
chk('关闭后仍在文章视图', (await ev("document.getElementById('artView').hidden")) === false);

const slug = await ev("document.querySelector('#artViewList .artcard [data-artpost]').getAttribute('data-artpost')");
await send('Page.navigate', { url: BASE + '/?page=articles&post=' + encodeURIComponent(slug) + '&t=' + Date.now() });
await sleep(1600);
chk('深链直达：阅读器自动打开', (await ev("document.getElementById('artDlg').open")) === true);

await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
await waitFor("document.querySelectorAll('#list .item').length>0");
await sleep(800);
await ev("document.querySelector('#tabArticles').click()");
await waitFor("document.querySelectorAll('#artViewList .artcard').length>0");
await sleep(500);
const t0 = await ev('location.href');
await ev("document.querySelector('#artViewList .artcard [data-artpost]').click()");
await sleep(900);
const t1 = await ev('location.href');
chk('从首页文章 tab 点开：仍是同一页（无 documents 导航）', t0.split('?')[0] === t1.split('?')[0], [t0, t1]);

await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
await sleep(500);
const escClosed = (await ev("document.getElementById('artDlg').open")) === false;
chk('Esc 关闭（或退回列表）', escClosed, await ev('location.search'));

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: BASE + '/?page=articles&post=' + encodeURIComponent(slug) + '&t=' + Date.now() });
await sleep(1800);
const m = await ev("(function(){var d=document.getElementById('artDlg');var r=d.getBoundingClientRect();var b=document.getElementById('artDlgBody');return {open:d.open,w:r.width,vw:innerWidth,h:r.height,vh:innerHeight,fs:parseFloat(getComputedStyle(b).fontSize),sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth};})()");
chk('390 阅读器满屏宽', m && Math.abs(m.w - m.vw) <= 2, m);
chk('390 正文 ≥16px', m && m.fs >= 16, m && m.fs);
chk('390 不横向溢出', m && m.sw <= m.cw + 1, m && [m.sw, m.cw]);

const bad = rows.filter((r) => !r.ok).length;
for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.extra ? '  [' + r.extra + ']' : ''));
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
try { ws.close(); } catch (e) {}
chrome.kill();
process.exit(bad === 0 ? 0 : 1);
