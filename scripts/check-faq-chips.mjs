// 门禁：问答页标签胶囊计数要跟着搜索走（而不是一直显示全量）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
function pass(name, cond, extra) { if (cond) { ok++; console.log('  PASS  ' + name); } else { bad++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); } }

const port = 9900 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-faqc-'));
const child = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });

let tg;
for (let i = 0; i < 60 && !tg; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); tg = l.find((x) => x.type === 'page'); } catch {}
  if (!tg) await sleep(250);
}
if (!tg) { console.log('Chrome 没起来'); process.exit(1); }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let n = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => { const i = ++n; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pend.set(i, r)); };
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description));
  return r.result && r.result.result && r.result.result.value;
}

const readChips = () => evalJs(`(() => {
  const chips = [...document.querySelectorAll('#tags .chip')].map(function (b) {
    return {
      tag: b.getAttribute('data-tag'),
      n: Number((b.querySelector('b') || {}).textContent || 0),
      on: b.classList.contains('is-on'),
      empty: b.classList.contains('is-empty'),
      aria: b.getAttribute('aria-disabled')
    };
  });
  const countText = (document.getElementById('count') || {}).textContent || '';
  const rows = document.querySelectorAll('#list details.qa').length;
  return { chips: chips, countText: countText, rows: rows };
})()`);

const typeSearch = async (kw) => {
  await evalJs('(function () { var q = document.getElementById("q"); q.value = ' + JSON.stringify(kw) + '; q.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await sleep(600);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/faq?v=' + Date.now() });
  await sleep(2200);

  // A. 基线：全部计数 = 条目数；标签计数之和 = 条目数（所有条目都有 tag 时）
  const baseState = await readChips();
  const baseAll = baseState.chips.find((c) => c.tag === 'all');
  pass('有「全部」胶囊且等于条目数', !!baseAll && baseAll.n === baseState.rows, JSON.stringify({ all: baseAll && baseAll.n, rows: baseState.rows }));
  const tagSum = baseState.chips.filter((c) => c.tag !== 'all').reduce((s, c) => s + c.n, 0);
  pass('标签计数之和等于条目数（无未分类条目）', tagSum === baseState.rows, 'sum=' + tagSum + ' rows=' + baseState.rows);
  pass('基线没有压暗的标签', baseState.chips.every((c) => !c.empty), '');
  pass('基线计数文案是「当前显示」', /当前显示/.test(baseState.countText), baseState.countText);

  // B. 搜一个只命中部分条目的词
  const kw = 'cron';
  await typeSearch(kw);
  const searched = await readChips();
  const sAll = searched.chips.find((c) => c.tag === 'all');
  pass('搜索后「全部」计数 = 命中数（不再显示全量）', !!sAll && sAll.n === searched.rows, JSON.stringify({ all: sAll && sAll.n, rows: searched.rows, base: baseAll && baseAll.n }));
  pass('搜索确实减少了条目', searched.rows > 0 && searched.rows < baseState.rows, 'rows=' + searched.rows);
  pass('计数文案是「命中 N 条」', /命中/.test(searched.countText), searched.countText);
  const emptied = searched.chips.filter((c) => c.tag !== 'all' && c.empty);
  pass('0 命中的标签被压暗并标 aria-disabled', emptied.length > 0 && emptied.every((c) => c.aria === 'true'), 'n=' + emptied.length);
  const dropped = searched.chips.filter((c) => !c.empty && c.tag !== 'all');
  pass('仍有命中的标签保持正常', dropped.length >= 1 && dropped.every((c) => c.aria === null), 'n=' + dropped.length);

  // C. 切到某个有命中的标签：其它标签的计数不该塌成 0（否则没法判断该切去哪）
  const pick = dropped[0];
  await evalJs('(function () { document.querySelector(\'#tags .chip[data-tag="' + pick.tag + '"]\').click(); })()');
  await sleep(600);
  const tagged = await readChips();
  const tagOthers = tagged.chips.filter((c) => c.tag !== 'all' && c.tag !== pick.tag);
  pass('切换标签后其它标签计数保持（按关键词统计）', tagOthers.every((c) => c.n === (searched.chips.find((x) => x.tag === c.tag) || {}).n), JSON.stringify(tagOthers.map((c) => c.tag + '=' + c.n)));
  pass('被选中的标签有 is-on', (tagged.chips.find((c) => c.tag === pick.tag) || {}).on === true, pick.tag);

  // D. 清空搜索：计数复原、压暗消失
  await typeSearch('');
  const reset = await readChips();
  const rAll = reset.chips.find((c) => c.tag === 'all');
  pass('清空后「全部」复原', !!rAll && rAll.n === baseAll.n, JSON.stringify({ all: rAll && rAll.n, base: baseAll.n }));
  pass('清空后没有压暗标签', reset.chips.every((c) => !c.empty), '');
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（' + ok + ' 项）');
process.exit(bad ? 1 : 0);
