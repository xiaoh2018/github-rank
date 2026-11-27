// 门禁：/articles 与 /faq 的「加载中」和「读失败」状态
// 1) 拦住 JSON → 必须出现可读的失败卡（标题/人话原因/重试/安抚），而不是「还没有文章」这种假话
// 2) 解除拦截后点「重试」→ 内容真的回来
// 3) 慢网（latency 2.5s）→ 900ms 时是骨架卡，不是一句话
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.argv[2] || 390);
const H = Number(process.argv[3] || 844);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const push = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

async function open() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ls-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
    if (!page) await sleep(200);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const failOn = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Fetch.requestPaused' && failOn.length) {
      ws.send(JSON.stringify({ id: ++id, method: 'Fetch.failRequest', params: { requestId: m.params.requestId, errorReason: 'ConnectionRefused' } }));
    }
  };
  const send = (method, params = {}) => { const myId = ++id; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((r) => pending.set(myId, r)); };
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    const v = r.result && r.result.result;
    if (v && v.subtype === 'error') throw new Error(v.description);
    return v ? v.value : undefined;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 761 });
  return { send, ev, child, failOn, ws };
}

async function blockJson(s, pattern) {
  s.failOn.push(pattern);
  await s.send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
}
async function unblock(s) {
  s.failOn.length = 0;
  await s.send('Fetch.disable');
}

const box = `(function(){const b=document.querySelector('#cards')||document.querySelector('#list');const r=b?b.getBoundingClientRect():null;return {err:!!document.querySelector('.loaderr'),errTitle:(document.querySelector('.loaderr b')||{}).textContent||'',errWhy:(document.querySelector('.loaderr p')||{}).textContent||'',retry:!!document.querySelector('[data-retry],[data-qa-retry]'),aside:!!document.querySelector('.loaderr .acts a'),note:(document.querySelector('.loaderr small')||{}).textContent||'',skel:document.querySelectorAll('.sk-card').length,bodyText:(document.body.innerText||'').replace(/\\s+/g,' '),kids:b?b.children.length:-1,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1}})()`;

// ---------- 1) /articles 断网 ----------
{
  const s = await open();
  await blockJson(s, '*/data/articles.json*');
  await s.send('Page.navigate', { url: BASE + '/articles?err=' + Date.now() });
  await sleep(2600);
  const st = await s.ev(box);
  push('/articles 读失败：出现失败卡', st.err, st.errTitle);
  push('/articles 读失败：标题说清是「文章没读出来」', st.errTitle.indexOf('文章没读出来') >= 0, st.errTitle);
  push('/articles 读失败：原因是人话（含「连不上」或「服务器」）', /连不上|服务器|缓存|拒绝/.test(st.errWhy), st.errWhy.slice(0, 40));
  push('/articles 读失败：有重试按钮', st.retry);
  push('/articles 读失败：有「先去看榜单」出口', st.aside);
  push('/articles 读失败：写了「不影响榜单」', /不影响/.test(st.note), st.note);
  push('/articles 读失败：不再说「还没有文章」', st.bodyText.indexOf('还没有文章') < 0);
  push('/articles 读失败：骨架已清空', st.skel === 0, 'skel=' + st.skel);
  push('/articles 读失败：没有横向溢出', !st.overflow);
  // 解除拦截 → 点重试 → 卡片回来
  await unblock(s);
  await s.ev(`(document.querySelector('[data-retry]')||{click(){}}).click()`);
  await sleep(2600);
  const after = await s.ev(`({cards:document.querySelectorAll('#cards .acard').length,err:!!document.querySelector('.loaderr')})`);
  push('/articles 点重试后内容真的回来', after.cards > 0 && !after.err, 'cards=' + after.cards);
  try { await s.send('Browser.close'); } catch {}
  s.child.kill();
}

// ---------- 2) /faq 断网 ----------
{
  const s = await open();
  await blockJson(s, '*/data/qa.json*');
  await s.send('Page.navigate', { url: BASE + '/faq?err=' + Date.now() });
  await sleep(2600);
  const st = await s.ev(box);
  push('/faq 读失败：出现失败卡', st.err, st.errTitle);
  push('/faq 读失败：标题说清是「问答没读出来」', st.errTitle.indexOf('问答没读出来') >= 0, st.errTitle);
  push('/faq 读失败：原因是人话', /连不上|服务器|缓存|拒绝/.test(st.errWhy), st.errWhy.slice(0, 40));
  push('/faq 读失败：有重试按钮', st.retry);
  push('/faq 读失败：不再只有「数据源可能暂时不可用」', st.bodyText.indexOf('数据源可能暂时不可用') < 0);
  push('/faq 读失败：没有横向溢出', !st.overflow);
  await unblock(s);
  await s.ev(`(document.querySelector('[data-qa-retry]')||{click(){}}).click()`);
  await sleep(2600);
  const after = await s.ev(`({qa:document.querySelectorAll('#list details.qa').length,err:!!document.querySelector('.loaderr')})`);
  push('/faq 点重试后问答真的回来', after.qa > 0 && !after.err, 'qa=' + after.qa);
  try { await s.send('Browser.close'); } catch {}
  s.child.kill();
}

// ---------- 3) 慢网：先看到骨架 ----------
{
  const s = await open();
  await s.send('Network.emulateNetworkConditions', { offline: false, latency: 2500, downloadThroughput: 200000, uploadThroughput: 100000, connectionType: 'cellular4g' });
  await s.send('Page.navigate', { url: BASE + '/articles?slow=' + Date.now() });
  await sleep(1000);
  const st = await s.ev(`({skel:document.querySelectorAll('.sk-card').length,txt:(document.querySelector('#cards')||{}).textContent||''})`);
  push('慢网下先看到骨架卡（≥3 张）', st.skel >= 3, 'skel=' + st.skel);
  push('不再是一句「正在加载文章…」', st.txt.indexOf('正在加载文章') < 0);
  try { await s.send('Browser.close'); } catch {}
  s.child.kill();
}

const bad = results.filter((r) => !r.ok);
console.log('');
if (bad.length) {
  console.log('FAILED ' + bad.length + ' / ' + results.length + '（' + W + 'px）');
  bad.forEach((b) => console.log(' - ' + b.name + (b.detail ? ' :: ' + b.detail : '')));
  process.exitCode = 1;
} else {
  console.log('ALL OK (' + results.length + ' 项，' + W + 'px)');
}