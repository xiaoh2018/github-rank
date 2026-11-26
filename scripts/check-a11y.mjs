// 无障碍门禁：四页 × 四主题，检查可访问名 / 对比度 / 表格语义 / img alt / lang / 焦点环
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const PAGES = (process.argv[2] || '/,/articles,/faq,/nav').split(',').map((s) => s.trim()).filter(Boolean);
const THEMES = (process.argv[3] || 'paper,dark,ink,stripe,notion').split(',');
const W = 1440;
const H = 900;

const port = 9900 + Math.floor(Math.random() * 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-a11y-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = list.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('no cdp target');
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
  const out = { unnamed: [], lowContrast: [], thNoScope: 0, tables: 0, imgNoAlt: 0, lang: document.documentElement.lang || '', chipNoState: 0, chips: 0 };
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
    // placeholder 只能当「提示」，不能当唯一的名字
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
  for (const im of document.querySelectorAll('img')) if (!im.hasAttribute('alt')) out.imgNoAlt++;
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

// 焦点环与键盘可见性：CSS 里必须有 :focus-visible 规则（不能只靠浏览器默认）
const focusCss = await evaluate(`(() => {
  let hits = 0;
  for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) if (r.selectorText && /:focus-visible/.test(r.selectorText)) hits++; } catch {} }
  return hits;
})()`);

const checks = [];
const ok = (name, cond, note) => checks.push({ name, pass: !!cond, note: note || '' });
ok('四页 × 五主题的控件都有可访问名', results.every((r) => r.unnamed.length === 0), [...new Set(results.flatMap((r) => r.unnamed))].slice(0, 6).join(' | '));
ok('正文与辅助文字对比度 ≥ 4.5（大字号 ≥ 3）', results.every((r) => r.lowContrast.length === 0), [...new Set(results.flatMap((r) => r.lowContrast.map((x) => r.theme + r.page + ' ' + x)))].slice(0, 5).join(' ; '));
ok('表格每个 th 都有 scope', results.every((r) => r.thNoScope === 0), results.filter((r) => r.thNoScope).map((r) => r.page + ':' + r.thNoScope).join(','));
ok('没有缺 alt 的 img', results.every((r) => r.imgNoAlt === 0), '');
ok('html 都有 lang', results.every((r) => !!r.lang), results.filter((r) => !r.lang).map((r) => r.page).join(','));
ok('分类胶囊都带 aria-pressed', results.every((r) => r.chipNoState === 0), results.filter((r) => r.chipNoState).map((r) => r.page + ':' + r.chipNoState).join(','));
ok('样式表里有 :focus-visible 焦点环（≥3 条）', focusCss >= 3, '命中 ' + focusCss + ' 条');

let bad = 0;
for (const c of checks) { if (c.pass) console.log('OK   ' + c.name); else { bad++; console.log('FAIL ' + c.name + (c.note ? ' → ' + c.note : '')); } }
console.log(bad ? bad + ' FAILED of ' + checks.length : 'ALL OK (' + checks.length + ')');

ws.close();
child.kill();
process.exit(bad ? 1 : 0);
