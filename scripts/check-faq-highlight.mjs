// 问答页搜索高亮门禁：命中词加 <mark>、计数显示「命中 N 条」、清空复原、答案里的 HTML 被当文本。
// 用法：先起 dev-server（8123），再 node scripts/check-faq-highlight.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9700 + Math.floor(Math.random() * 200);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-faqhl-'));
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
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const openFaq = async () => { await send('Page.navigate', { url: base + '/faq?v=' + Date.now() }); await sleep(1600); };
const search = async (text) => {
  await evalJs(`(() => { const i = document.getElementById('q'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(300);
};
const apiQa = async (body) => {
  const r = await fetch(base + '/api/qa', body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, json: await r.json().catch(() => null) };
};

// 门禁会临时改写 data/qa.json（保存链路），跑完还原成开始前的内容，避免只差 updatedAt 的噪声提交
const qaFile = 'data/qa.json';
const qaOrig = fs.existsSync(qaFile) ? fs.readFileSync(qaFile) : null;
const orig = await apiQa();
const origQa = orig && orig.json && orig.json.qa;

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await openFaq();

  console.log('== 1. 基线 ==');
  const b = await evalJs(`(() => ({
    items: document.querySelectorAll('details.qa').length,
    marks: document.querySelectorAll('.hitmark').length,
    count: (document.getElementById('count') || {}).textContent || ''
  }))()`);
  ok('有问答条目', b && b.items > 0, b && b.items);
  ok('未搜索时没有高亮', b && b.marks === 0, b && b.marks);
  ok('计数显示总条数与当前显示', b && /共\s*\d+\s*条/.test(b.count) && /当前显示/.test(b.count), b && b.count);

  console.log('== 2. 搜答案里的词：答案高亮、计数变「命中」 ==');
  await search('cron');
  const s1 = await evalJs(`(() => {
    const mark = document.querySelector('.qa .ans .hitmark');
    return {
      items: document.querySelectorAll('details.qa').length,
      ansMarks: document.querySelectorAll('.qa .ans .hitmark').length,
      qMarks: document.querySelectorAll('.qa .qtext .hitmark').length,
      text: mark ? mark.textContent : '',
      bg: mark ? getComputedStyle(mark).backgroundColor : '',
      count: (document.getElementById('count') || {}).textContent || ''
    };
  })()`);
  ok('答案里命中处出现 <mark>', s1 && s1.ansMarks >= 1, JSON.stringify(s1));
  ok('mark 文本就是命中词（大小写随原文）', s1 && s1.text.toLowerCase() === 'cron', s1 && s1.text);
  ok('高亮底色不是透明', s1 && s1.bg && s1.bg !== 'rgba(0, 0, 0, 0)' && s1.bg !== 'transparent', s1 && s1.bg);
  ok('计数变成「命中 N 条」', s1 && /命中\s*\d+\s*条/.test(s1.count), s1 && s1.count);
  ok('只命中相关条目', s1 && s1.items >= 1 && s1.items <= b.items, s1 && s1.items);

  console.log('== 3. 多关键词：两个词都高亮 ==');
  await search('数据 更新');
  const s2 = await evalJs(`(() => {
    const marks = Array.from(document.querySelectorAll('.hitmark')).map(m => m.textContent.toLowerCase());
    return { items: document.querySelectorAll('details.qa').length, marks: marks.join('|'), hasBoth: marks.indexOf('数据') > -1 && marks.indexOf('更新') > -1 };
  })()`);
  ok('多词都命中时才显示条目', s2 && s2.items >= 1, s2 && s2.items);
  ok('两个关键词都被高亮', s2 && s2.hasBoth === true, s2 && s2.marks);

  console.log('== 4. 清空复原 ==');
  await search('');
  const s3 = await evalJs(`(() => ({ items: document.querySelectorAll('details.qa').length, marks: document.querySelectorAll('.hitmark').length, count: (document.getElementById('count') || {}).textContent || '' }))()`);
  ok('清空后没有残留高亮', s3 && s3.marks === 0, s3 && s3.marks);
  ok('清空后条目恢复', s3 && s3.items === b.items, s3 && s3.items);
  ok('清空后计数恢复', s3 && /当前显示/.test(s3.count), s3 && s3.count);

  console.log('== 5. 搜不到 ==');
  await search('ZZQ不存在的问题');
  const s4 = await evalJs(`(() => ({ empty: (document.querySelector('#list .empty') || {}).textContent || '', marks: document.querySelectorAll('.hitmark').length }))()`);
  ok('显示空态提示', /没有匹配的问题/.test(s4 && s4.empty), s4 && s4.empty);
  ok('空态没有高亮残留', s4 && s4.marks === 0, s4 && s4.marks);

  console.log('== 6. 答案里的 HTML 必须当文本（转义） ==');
  const tmpItems = [{ q: '__门禁__答案含标签', a: '这是 <b>不该加粗</b> 与 a<b 的比较', tag: '测试' }];
  const put = await apiQa({ password: PW, qa: { intro: (origQa && origQa.intro) || '', items: tmpItems } });
  ok('临时写入问答', put.status === 200 && put.json && put.json.ok, put.status);
  await openFaq();
  await search('不该加粗');
  const s5 = await evalJs(`(() => {
    const d = document.querySelector('details.qa .ans');
    return {
      html: d ? d.innerHTML : '',
      hasB: !!(d && d.querySelector('b')),
      text: d ? d.textContent : '',
      marks: d ? d.querySelectorAll('.hitmark').length : 0
    };
  })()`);
  ok('答案里没有真的 <b> 元素', s5 && s5.hasB === false, s5 && s5.html.slice(0, 120));
  ok('标签以文本形式显示', s5 && s5.text.indexOf('<b>不该加粗</b>') > -1, s5 && s5.text.slice(0, 80));
  ok('转义后仍能高亮命中词', s5 && s5.marks >= 1, s5 && s5.marks);
} finally {
  try { if (origQa) await apiQa({ password: PW, qa: origQa }); } catch {}
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  const back = await apiQa();
  const n = (back && back.json && back.json.qa && back.json.qa.items || []).length;
  console.log('还原问答：' + n + ' 条' + (origQa ? '（原 ' + origQa.items.length + ' 条）' : ''));
}

if (qaOrig && fs.existsSync(qaFile) && !fs.readFileSync(qaFile).equals(qaOrig)) {
  fs.writeFileSync(qaFile, qaOrig);
  console.log('已把 data/qa.json 还原成跑之前的内容（只差 updatedAt 也不留噪声）');
}
console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
