// 门禁：/faq 的标签胶囊在 320px 单行横滚 + 搜索框触控尺寸
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (n, ok, extra) => rows.push({ n, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9950 + Math.floor(Math.random() * 40);
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-faqn-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' });

const wsUrl = await (async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome not ready');
})();

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const waits = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result && r.result.result ? r.result.result.value : null;
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + '/faq' });
  await sleep(2600);

  const base = await evalJs(`(function(){
    var box = document.getElementById('tags');
    if (!box) return { missing: true };
    var cs = getComputedStyle(box);
    var chips = box.querySelectorAll('.chip');
    var h = chips.length ? Math.round(chips[0].getBoundingClientRect().height) : -1;
    var q = document.getElementById('q');
    var qr = q ? q.getBoundingClientRect() : null;
    return {
      chips: chips.length, wrap: cs.flexWrap, of: cs.overflowX, h: h,
      sw: box.scrollWidth, cw: box.clientWidth,
      mask: (cs.maskImage || cs.webkitMaskImage || ''),
      hasEnd: box.classList.contains('x-end'),
      qH: qr ? Math.round(qr.height) : -1, qW: qr ? Math.round(qr.width) : -1,
      docW: document.documentElement.scrollWidth, cliW: document.documentElement.clientWidth
    };
  })()`);
  push('320：标签条存在且有 4 个胶囊', base && base.chips === 4, base && base.chips);
  push('320：标签条不换行', base && base.wrap === 'nowrap', base && base.wrap);
  push('320：标签条可横滚', base && base.of === 'auto', base && base.of);
  push('320：胶囊高度 ≥38', base && base.h >= 38, base && base.h);
  push('320：搜索框高 ≥44', base && base.qH >= 44, base && base.qH);
  push('320：搜索框撑满一行（≥240）', base && base.qW >= 240, base && base.qW);
  push('320：整页不横向溢出', base && base.docW <= base.cliW + 1, base ? base.docW + '/' + base.cliW : '');

  // 造溢出：临时插 3 个长胶囊（只测 CSS，不改数据）
  const over = await evalJs(`(function(){
    var box = document.getElementById('tags');
    for (var i = 0; i < 3; i++) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip';
      b.textContent = '很长的分类标签' + i;
      b.setAttribute('data-injected', '1');
      box.appendChild(b);
    }
    box.scrollLeft = 0;
    box.dispatchEvent(new Event('scroll'));
    var cs = getComputedStyle(box);
    return { sw: box.scrollWidth, cw: box.clientWidth, mask: (cs.maskImage || cs.webkitMaskImage || ''), hasEnd: box.classList.contains('x-end') };
  })()`);
  push('320：胶囊多到溢出（测给下面断言用）', over && over.sw > over.cw, over ? over.sw + '/' + over.cw : '');
  push('320：溢出时右缘有渐隐（mask 含 linear-gradient）', over && /linear-gradient/.test(over.mask), over && over.mask.slice(0, 60));
  push('320：起始位置不隐藏渐隐', over && over.hasEnd === false, over && over.hasEnd);

  const atEnd = await evalJs(`(function(){
    var box = document.getElementById('tags');
    box.scrollLeft = box.scrollWidth;
    box.dispatchEvent(new Event('scroll'));
    var cs = getComputedStyle(box);
    return { hasEnd: box.classList.contains('x-end'), mask: (cs.maskImage || cs.webkitMaskImage || '') };
  })()`);
  push('320：划到末尾出现 x-end', atEnd && atEnd.hasEnd === true, atEnd && atEnd.hasEnd);
  push('320：到末尾后渐隐撤掉', atEnd && atEnd.mask === 'none', atEnd && atEnd.mask);

  const clean = await evalJs(`(function(){
    var box = document.getElementById('tags');
    Array.prototype.forEach.call(box.querySelectorAll('[data-injected]'), function (b) { b.remove(); });
    return box.querySelectorAll('.chip').length;
  })()`);
  push('320：清掉注入的测试胶囊', clean === 4, clean);
} finally {
  ws.close();
  child.kill();
}

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.n + (r.extra ? '  [' + r.extra + ']' : '')); }
console.log(bad === 0 ? '全部通过（' + rows.length + ' 项，320px）' : bad + ' 项失败 / ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
