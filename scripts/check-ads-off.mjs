// 广告位全关时，前台不应留任何空位（0 高容器、占位文字、空边距）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const AD_SEL = '.ad-slot,.ad-inline,.ad-inner,.ad-ticker,.ad-modal,.ad-strip';
const exe = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 端口用系统分配的空闲端口：门禁并发跑时，随机端口会撞上别的 chrome 实例，
// 表现是「no cdp target」并 exit 2（第 18 轮全量跑就这么红过一次）。
async function freePort() {
  return await new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}
let child = null;
let prof = '';
let port = 0;
let ws = null;
let n = 0; const pending = new Map();
for (let attempt = 0; attempt < 3 && !ws; attempt++) {
  port = await freePort();
  prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  child = spawn(exe, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
      break;
    }
  } catch {}
  await sleep(200);
}
  if (!ws) { try { child.kill(); } catch (e) {} await sleep(300); }
}
if (!ws) { console.log('no cdp target（换了 3 个空闲端口都没连上，先清掉残留 chrome）'); process.exit(2); }
const send = (m, p) => new Promise((res) => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result && r.result.result ? r.result.result.value : null;
};
let bad = 0;
const ok = (name, cond, extra) => { if (cond) console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); else { bad++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); } };

// 1) 数据侧：10 个槽位全部关闭
const site = await (await fetch(BASE + '/api/site?t=' + Date.now())).json();
const slots = (site && site.site && site.site.ad && site.site.ad.slots) || {};
const ids = Object.keys(slots);
ok('站点已配置 10 个广告位', ids.length === 10, ids.join(','));
ok('全部广告位都是关闭状态（否则本门禁的前提不成立）', ids.every((k) => slots[k] && slots[k].enabled !== true), 'enabled=' + ids.filter((k) => slots[k] && slots[k].enabled).length);
const ticker = (site.site.ad && site.site.ad.ticker) || {};
ok('顶部滚动条也是关闭的', ticker.enabled !== true, 'enabled=' + ticker.enabled);

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

for (const [label, url] of [['首页', '/'], ['文章视图', '/?page=articles'], ['导航视图', '/?page=nav'], ['文章静态页', '/articles'], ['问答页', '/faq']]) {
  await send('Page.navigate', { url: BASE + url + (url.includes('?') ? '&' : '?') + 't=' + Date.now() });
  await sleep(2200);
  const info = JSON.parse(await ev(`(() => {
    const nodes = [...document.querySelectorAll('${AD_SEL}')];
    const live = nodes.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const text = document.body.innerText || '';
    return JSON.stringify({
      n: nodes.length,
      live: live.map((el) => el.className + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)),
      adword: /广告招商|此处放广告|暂无广告|联系投放|广告合作/.test(text)
    });
  })()`));
  ok(label + '：没有可见的广告容器', info.live.length === 0, info.live.join(' | ') || 'nodes=' + info.n);
  ok(label + '：正文里没有「广告招商 / 暂无广告」这类占位文案', info.adword === false, '');
}

ws.close();
child.kill();
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（13 项）');
process.exit(bad ? 1 : 0);
