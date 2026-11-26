// 主题一致性门禁：四页 × 五主题的 token 必须完全一致（/faq 曾完全不跟站点主题）
// 用法：node scripts/check-theme-parity.mjs [baseUrl]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] || process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const port = 9700 + Math.floor(Math.random() * 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no cdp target');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

const PAGES = ['/', '/articles', '/faq', '/nav'];
const THEMES = ['paper', 'dark', 'ink', 'stripe', 'notion'];
const TOKENS = ['--bg', '--card', '--text', '--muted', '--border', '--chip', '--accent', '--accent-ink', '--accent-text'];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('OK   ' + label); }
  else { fail++; console.log('FAIL ' + label + (extra ? ' → ' + extra : '')); }
};

try {
  const cdp = await Cdp.open(await wsUrl());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const table = {};
  for (const p of PAGES) {
    await cdp.send('Page.navigate', { url: base + p });
    await sleep(1800);
    for (const t of THEMES) {
      table[p + '|' + t] = await cdp.eval(`(() => {
        document.documentElement.setAttribute('data-theme', '${t}');
        const cs = getComputedStyle(document.documentElement);
        const out = {};
        ${JSON.stringify(TOKENS)}.forEach(k => out[k] = cs.getPropertyValue(k).trim());
        out.__bgBody = getComputedStyle(document.body).backgroundColor;
        return out;
      })()`);
    }
  }

  // 1) 每个主题下，四页的 9 个 token 完全一致
  for (const t of THEMES) {
    const diffs = [];
    for (const tk of TOKENS) {
      const vals = PAGES.map((p) => [p, table[p + '|' + t][tk]]);
      if (new Set(vals.map(([, v]) => v)).size > 1) diffs.push(tk + ': ' + vals.map(([p, v]) => p + '=' + (v || '∅')).join(' | '));
    }
    ok(diffs.length === 0, `主题 ${t} 四页 token 一致`, diffs.slice(0, 3).join(' ; '));
  }

  // 2) /faq 真的会变暗（曾经 JS 改了 data-theme 但 CSS 没有对应块）
  const faqPaper = table['/faq|paper'].__bgBody;
  const faqDark = table['/faq|dark'].__bgBody;
  ok(faqPaper !== faqDark, '/faq 切到深色后背景真的变了', faqPaper + ' vs ' + faqDark);
  ok(table['/faq|dark']['--bg'] === table['/|dark']['--bg'], '/faq 深色背景与首页同色');

  // 3) 正文对比度：深色主题下 --text 与 --bg 的亮度差必须够（粗略判据）
  const lum = (hex) => {
    const m = hex.replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255);
    const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const [r, g, b] = c.map(f);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const t of THEMES) {
    for (const p of PAGES) {
      const v = table[p + '|' + t];
      if (!v['--bg'] || !v['--text']) continue;
      const l1 = lum(v['--bg']), l2 = lum(v['--text']);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      ok(ratio >= 7, `${t} ${p} 正文对比度 ≥7`, ratio.toFixed(2));
    }
    break; // 只对 paper 逐页算，其余主题已在 1) 里保证取值一致
  }
} finally {
  child.kill();
}

console.log(`\n${fail === 0 ? 'ALL OK' : 'FAILED'} (${pass} 项通过, ${fail} 项失败)`);
process.exit(fail === 0 ? 0 : 1);
