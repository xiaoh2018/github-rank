// 榜单分页器「跳到第 N 页」门禁：输入框存在、范围夹取、回车生效、列表真的换了、打印隐藏。
// 用法：先起 dev-server（8123），再 node scripts/check-pager-jump.mjs [--shot 输出png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shotArg = process.argv.indexOf('--shot');
const shotOut = shotArg > -1 ? process.argv[shotArg + 1] : '';
const port = 9700 + Math.floor(Math.random() * 200);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-jump-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

let target;
for (let i = 0; i < 40 && !target; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/?v=' + Date.now() });
await sleep(3000);

console.log('== 1. 输入框存在且范围正确 ==');
const meta = await evalJs(`(() => {
  const el = document.getElementById('pgJump');
  if (!el) return null;
  return {
    tag: el.tagName, type: el.type, min: el.min, max: el.max, value: el.value,
    label: el.getAttribute('aria-label') || '',
    pages: document.getElementById('pageInfo').textContent,
    prevDisabled: document.getElementById('prev').disabled,
    nextDisabled: document.getElementById('next').disabled
  };
})()`);
ok('分页器里有「跳到第 N 页」输入框', !!meta, JSON.stringify(meta));
ok('是数字输入且有无障碍名称', meta && meta.type === 'number' && /跳到第几页/.test(meta.label), JSON.stringify(meta));
ok('max 与总页数一致（第 1 页）', meta && meta.pages.indexOf('第 1 / ' + meta.max + ' 页') === 0, meta && meta.pages);
ok('第 1 页时「上一页」禁用', meta && meta.prevDisabled === true, meta && meta.prevDisabled);

console.log('== 2. 输入页码并回车 ==');
const jumped = await evalJs(`(() => {
  const el = document.getElementById('pgJump');
  el.focus();
  el.value = '7';
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return new Promise(res => setTimeout(() => {
    const items = [...document.querySelectorAll('#list .item')].filter(x => !x.classList.contains('ad-inline'));
    res({ info: document.getElementById('pageInfo').textContent, first: items.length ? items[0].querySelector('.rank') ? items[0].querySelector('.rank').textContent.trim() : items[0].textContent.slice(0, 18) : '', count: items.length, value: el.value });
  }, 400));
})()`);
ok('回车后跳到第 7 页', jumped && jumped.info.indexOf('第 7 /') === 0, jumped && jumped.info);
ok('列表真的换了页（首页名次是 121 起）', jumped && /121/.test(jumped.first), jumped && jumped.first);
ok('每页仍是 20 条', jumped && jumped.count === 20, jumped && jumped.count);

console.log('== 3. 越界与非法输入 ==');
const clampHi = await evalJs(`(() => {
  const el = document.getElementById('pgJump');
  el.value = '999';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return new Promise(res => setTimeout(() => res({
    info: document.getElementById('pageInfo').textContent, value: el.value,
    nextDisabled: document.getElementById('next').disabled
  }), 300));
})()`);
ok('超出总页数被夹到最后一页', clampHi && clampHi.info.indexOf('第 ' + clampHi.value + ' /') === 0 && clampHi.value !== '999' && clampHi.nextDisabled === true, JSON.stringify(clampHi));

const clampLo = await evalJs(`(() => {
  const el = document.getElementById('pgJump');
  el.value = '0';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return new Promise(res => setTimeout(() => res({
    info: document.getElementById('pageInfo').textContent, value: el.value,
    prevDisabled: document.getElementById('prev').disabled
  }), 300));
})()`);
ok('0 被夹到第 1 页', clampLo && clampLo.value === '1' && clampLo.prevDisabled === true, JSON.stringify(clampLo));

const junk = await evalJs(`(() => {
  const el = document.getElementById('pgJump');
  el.value = '';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return new Promise(res => setTimeout(() => res({ value: el.value, info: document.getElementById('pageInfo').textContent }), 300));
})()`);
ok('空值回填当前页、不乱跳', junk && junk.value === '1' && junk.info.indexOf('第 1 /') === 0, JSON.stringify(junk));

console.log('== 4. 打印时隐藏 ==');
const printHide = await evalJs(`(() => {
  for (const sh of document.styleSheets) {
    let rules; try { rules = sh.cssRules; } catch (e) { continue; }
    for (const r of rules) {
      if (r.type === CSSRule.MEDIA_RULE && /print/.test(r.conditionText || '')) {
        for (const rr of r.cssRules) if (rr.selectorText && rr.selectorText.indexOf('.pjump') > -1) return true;
      }
    }
  }
  return false;
})()`);
ok('打印样式里隐藏了跳页输入', printHide === true, printHide);

if (shotOut) {
  await evalJs(`(() => { const el = document.getElementById('pgJump'); el.value = '2'; el.dispatchEvent(new Event('change', { bubbles: true })); const p = document.getElementById('pager'); if (p) p.scrollIntoView({block:'center'}); return 1; })()`);
  await sleep(700);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(shotOut, Buffer.from(shot.result.data, 'base64'));
  console.log('saved ' + shotOut + ' ' + fs.statSync(shotOut).size + 'B');
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
try { ws.close(); } catch {}
try { child.kill(); } catch {}
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
