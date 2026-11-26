import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 390);
const H = Number(process.argv[3] || 844);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9400 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-rf-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  if (!page) await sleep(200);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
let mode = 'none';
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') {
    const rid = m.params.requestId;
    const reply = (payload) => ws.send(JSON.stringify({ id: ++id, method: 'Fetch.fulfillRequest', params: payload }));
    const fail = () => ws.send(JSON.stringify({ id: ++id, method: 'Fetch.failRequest', params: { requestId: rid, errorReason: 'ConnectionRefused' } }));
    if (mode === 'net') { fail(); return; }
    const body = mode === '401'
      ? JSON.stringify({ message: 'Bad credentials' })
      : JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4' });
    const status = mode === '401' ? 401 : 403;
    reply({ requestId: rid, responseCode: status, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body: Buffer.from(body).toString('base64') });
  }
};
const send = (method, params = {}) => { const myId = ++id; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((r) => pending.set(myId, r)); };
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const v = r.result && r.result.result; return v ? v.value : undefined; };

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'OK   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 761 });
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/gh-search*', requestStage: 'Request' }, { urlPattern: '*api.github.com/search*', requestStage: 'Request' }] });
await send('Page.navigate', { url: BASE + '/?rf=' + Date.now() });
await sleep(2600);
check('页面先正常出榜单', (await ev(`document.querySelectorAll('#list .item').length`)) >= 10, 'cards=' + (await ev(`document.querySelectorAll('#list .item').length`)));

async function runRefresh() {
  await ev(`document.getElementById('btnRefresh').click()`);
  await sleep(2600);
  return await ev(`(() => {
    const s = document.getElementById('status');
    const act = s.querySelector('.status-act');
    const txt = (s.innerText || '').trim();
    const rawLeak = /API rate limit|Bad credentials|HTTP 4\\d\\d/.test(txt);
    const cards = document.querySelectorAll('#list .item').length;
    const over = s.scrollWidth > s.clientWidth + 2;
    return JSON.stringify({ txt, hasAct: !!act, actLabel: act ? act.textContent.trim() : '', rawLeak, cards, over });
  })()`);
}

mode = '403';
let r = JSON.parse(await runRefresh());
check('403：状态行说清是额度用完', /额度|太频繁|限制/.test(r.txt), r.txt.slice(0, 60));
check('403：给了「下一步」按钮', r.hasAct && r.actLabel.length > 0, r.actLabel);
check('403：不把 GitHub 原文糊给读者', !r.rawLeak, r.txt.slice(0, 40));
check('403：榜单没被清空', r.cards >= 10, 'cards=' + r.cards);
check('403：状态行不溢出', !r.over, 'overflow=' + r.over);
check('403：说明「当前仍显示之前的数据」', /仍显示之前的数据/.test(r.txt), '');

await ev(`document.querySelector('#status .status-act').click()`);
await sleep(400);
const afterAct = JSON.parse(await ev(`(() => {
  const box = document.getElementById('settings');
  const inp = document.getElementById('token');
  return JSON.stringify({ open: !!(box && !box.hidden), focused: document.activeElement === inp });
})()`));
check('点「去设置」打开设置面板', afterAct.open, '');
check('点「去设置」焦点落到 Token 输入框', afterAct.focused, '');

await ev(`document.getElementById('settings').hidden = true`);
mode = '401';
r = JSON.parse(await runRefresh());
check('401：说清 Token 无效', /Token|凭证|凭据/.test(r.txt), r.txt.slice(0, 50));
check('401：也给「去设置」', r.hasAct, r.actLabel);

mode = 'net';
r = JSON.parse(await runRefresh());
check('断网：说人话（网络/连不上）', /网络|连不上|失败/.test(r.txt), r.txt.slice(0, 50));
check('断网：榜单仍在', r.cards >= 10, 'cards=' + r.cards);

const failed = results.filter((x) => !x.pass);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL OK (' + results.length + ' 项，' + W + 'px)'));
try { await send('Browser.close'); } catch {}
child.kill();
process.exit(failed.length ? 1 : 0);