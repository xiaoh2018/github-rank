// 无障碍门禁：四页 × 五主题，检查可访问名 / 对比度 / 表格语义 / img alt / lang / aria 状态 / 焦点环
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const PAGES = (process.argv[2] || '/,/articles,/faq,/nav').split(',').map((s) => s.trim()).filter(Boolean);
const THEMES = (process.argv[3] || 'paper,dark,ink,stripe,notion').split(',');
const W = 1440;
const H = 900;

// 端口必须真的空闲：写死范围会和残留的无头 Chrome 撞车（连上了但 /json/list 里没有 page）
const port = await new Promise((res) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-a11y-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = list.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('no cdp target on port ' + port);
}

const t = await findTarget();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
};
const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const AUDIT = `(() => {
  const out = { unnamed: [], lowContrast: [], thNoScope: 0, tables: 0, imgBad: [], lang: document.documentElement.lang || '', chipNoState: 0, chips: 0, focusHits: 0 };
  const labelFor = new Set([...document.querySelectorAll('label[for]')].map((l) => l.getAttribute('for')));
  const nameOf = (el) => {
    const t = (el.innerText || el.textContent || '').trim(); if (t) return t;
    const al = el.getAttribute('aria-label'); if (al && al.trim()) return al;
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const n = document.getElementById(lb); if (n && n.textContent.trim()) return n.textContent.trim(); }
    const ti = el.getAttribute('title'); if (ti && ti.trim()) return ti;
    if (el.id && labelFor.has(el.id)) return 'label';
    const img = el.querySelector && el.querySelector('img[alt]:not([alt=""])'); if (img) return 'img';
    if (el.tagName === 'INPUT' && (el.value || '').trim()) return 'value';
    if (el.tagName === 'INPUT' && el.getAttribute('placeholder')) return 'placeholder-only';
    return '';
  };
  const interactive = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[role=button],[role=tab],[role=link]')];
  for (const el of interactive) {
    if (el.closest('[hidden]')) continue;
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const nm = nameOf(el);
    if (!nm || nm === 'placeholder-only') out.unnamed.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
  }
  for (const c of document.querySelectorAll('.chip[data-cat],.chip[data-tag],#cats .chip,#artChips .chip,#faqChips .chip')) { out.chips++; if (!c.hasAttribute('aria-pressed')) out.chipNoState++; }
  const parse = (c) => { const m = (c || '').match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.7) return c; n = n.parentElement; } const b = parse(getComputedStyle(document.body).backgroundColor); if (b && b.a > 0.7) return b; return parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 }; };
  const SAMPLES = ['.meta', '.note', '.fresh', '.sub', '.artcard-mins', '.stat', '.chip', '.qtag', 'footer', '.slugline', '.art-lock', '.hint', '#status', '.card p', 'td', '.side .nav', '.artvlead'];
  for (const sel of SAMPLES) {
    for (const el of [...document.querySelectorAll(sel)].slice(0, 4)) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || +st.opacity === 0) continue;
      const fg = parse(st.color); if (!fg) continue;
      const bg = bgOf(el);
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
      const px = parseFloat(st.fontSize); const bold = +st.fontWeight >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      if (ratio < need) out.lowContrast.push(sel + ' ' + ratio + '<' + need);
    }
  }
  for (const tb of document.querySelectorAll('table')) { out.tables++; for (const th of tb.querySelectorAll('th')) if (!th.hasAttribute('scope')) out.thNoScope++; }
  for (const im of document.querySelectorAll('img')) {
    if (im.closest('[hidden]')) continue;
    const src = im.getAttribute('src') || '';
    if (!src || src.indexOf('data:') === 0) continue;
    if (!im.hasAttribute('alt')) out.imgBad.push(src.slice(-36));
  }
  // :focus-visible 规则可能在 @media / @supports 里，递归数
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText && /:focus-visible/.test(r.selectorText)) out.focusHits++;
      if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const ss of document.styleSheets) { try { walk(ss.cssRules); } catch (e) {} }
  return out;
})()`;

const results = [];
for (const theme of THEMES) {
  for (const p of PAGES) {
    await send('Page.navigate', { url: BASE + p });
    await sleep(1300);
    await evaluate('document.documentElement.setAttribute("data-theme","' + theme + '");"ok"');
    await sleep(120);
    results.push({ theme, page: p, ...(await evaluate(AUDIT)) });
  }
}

const checks = [];
const ok = (name, cond, note) => checks.push({ name, pass: !!cond, note: note || '' });
ok('四页 × 五主题的控件都有可访问名', results.every((r) => r.unnamed.length === 0), [...new Set(results.flatMap((r) => r.unnamed))].slice(0, 6).join(' | '));
ok('正文与辅助文字对比度 ≥ 4.5（大字号 ≥ 3）', results.every((r) => r.lowContrast.length === 0), [...new Set(results.flatMap((r) => r.lowContrast.map((x) => r.theme + r.page + ' ' + x)))].slice(0, 5).join(' ; '));
ok('表格每个 th 都有 scope', results.every((r) => r.thNoScope === 0), results.filter((r) => r.thNoScope).map((r) => r.page + ':' + r.thNoScope).join(','));
ok('没有缺 alt 的 img', results.every((r) => r.imgBad.length === 0), [...new Set(results.flatMap((r) => r.imgBad))].slice(0, 4).join(' | '));
ok('html 都有 lang', results.every((r) => !!r.lang), results.filter((r) => !r.lang).map((r) => r.page).join(','));
ok('分类胶囊都带 aria-pressed', results.every((r) => r.chipNoState === 0), results.filter((r) => r.chipNoState).map((r) => r.page + ':' + r.chipNoState).join(','));
// 键盘可达：按 Tab 之后，真正拿到焦点的元素必须有可见的焦点环（不是靠浏览器默认虚线）
await send('Page.navigate', { url: BASE + '/' });
// 等页面真的渲染出来：Chrome 的错误页也有 a 和 button，会把焦点环测成浏览器默认的 1px
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(200);
  ready = await evaluate(`!!document.querySelector('#list, #q, #status') && document.readyState !== 'loading'`);
  if (ready) break;
}
if (!ready) throw new Error('首页没加载出来（dev-server 是否在跑？）');
await sleep(400);
const focusRing = [];
for (let i = 0; i < 6; i++) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await sleep(90);
  const st = await evaluate(`(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return { tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), w: parseFloat(cs.outlineWidth) || 0, style: cs.outlineStyle, shadow: cs.boxShadow };
  })()`);
  if (st) focusRing.push(st);
}
const ringOk = focusRing.filter((x) => x.w >= 2 || (x.shadow && x.shadow !== 'none')).length;
ok('连按 Tab 六次，每一步焦点元素都有可见焦点环', focusRing.length >= 4 && ringOk === focusRing.length,
  '拿到焦点 ' + focusRing.length + ' 个，有环 ' + ringOk + ' 个：' + focusRing.map((x) => x.tag + ':' + x.w + 'px').join(' '));
ok('页面样式里声明了 :focus-visible（不是全靠浏览器默认）', Math.max(...results.map((r) => r.focusHits)) >= 1, '最多 ' + Math.max(...results.map((r) => r.focusHits)) + ' 条');

let bad = 0;
for (const c of checks) { if (c.pass) console.log('OK   ' + c.name); else { bad++; console.log('FAIL ' + c.name + (c.note ? ' → ' + c.note : '')); } }
console.log(bad ? bad + ' FAILED of ' + checks.length : 'ALL OK (' + checks.length + ')');

ws.close();
child.kill();
setTimeout(() => process.exit(bad ? 1 : 0), 200);
