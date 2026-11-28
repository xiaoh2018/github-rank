import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const PW = 'dev';
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const adm = await (await fetch(BASE + '/admin')).text();
  push('后台用「精确恢复」撤销单篇删除（action restore）', adm.includes("action: 'restore'"));
  push('确认框写明 10 分钟窗口与只保留最近一次', adm.includes('10 分钟内可以点「撤销」'));
  finish();
}

const post = async (body) => (await fetch(BASE + '/api/articles', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(Object.assign({ password: PW }, body)),
})).json();
const getList = async () => (await (await fetch(BASE + '/api/articles')).json()).articles;
const tempTitles = (list) => list.map((a) => a.title).filter((t) => /^(恢复测试-|撤销UI-)/.test(t));

async function addTemp(title) {
  const r = await post({ action: 'add', article: { title, category: 'tech', body: '正文 ' + title, date: '2026-11-28' } });
  if (!r.ok) return null;
  return r.articles.filter((a) => a.title === title).map((a) => String(a.id))[0] || null;
}
async function delById(id) { if (id) await post({ action: 'remove', id }); }

// ── A. 接口段：删中间 → 期间别人新增 → 恢复只插回那一篇
const a1 = await addTemp('恢复测试-1');
const a2 = await addTemp('恢复测试-2');
const a3 = await addTemp('恢复测试-3');
let list = await getList();
push('准备三篇临时文章', tempTitles(list).length === 3, tempTitles(list).join(','));

await delById(a2);
list = await getList();
push('删除中间那篇', !list.some((a) => a.title === '恢复测试-2'), tempTitles(list).join(','));

const a4 = await addTemp('恢复测试-4');   // 模拟「别人在这期间新增」
const res = await post({ action: 'restore' });
list = await getList();
const seq = tempTitles(list);
push('恢复返回成功并带回那篇', res.ok && res.restored && res.restored.title === '恢复测试-2', res.ok ? (res.restored || {}).title : res.error);
push('按原位置插回（顺序不被打乱）', seq.join(',') === '恢复测试-1,恢复测试-2,恢复测试-3,恢复测试-4', seq.join(','));
push('没有覆盖期间别人新增的文章', list.some((a) => a.title === '恢复测试-4'), list.some((a) => a.title === '恢复测试-4'));

const again = await post({ action: 'restore' });
push('再点一次撤销会明确说没有可恢复的', !again.ok && /没有可恢复的删除/.test(again.error || ''), again.error || '');

for (const id of [a1, a2, a3, a4]) await delById(id);

// ── B. 界面段：只针对自己造的文章，不碰线上的真实文章
const b1 = await addTemp('撤销UI-A');
const b2 = await addTemp('撤销UI-B');

const cdp = await openCdp({ width: 1440, height: 950 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2800));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="articles"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 1200));

  const count = () => cdp.js(`document.querySelectorAll('#artTbody [data-artdel]').length`);
  const hasA = () => cdp.js(`[].slice.call(document.querySelectorAll('#artTbody [data-artdel]')).some(function(b){return b.closest('tr').textContent.indexOf('撤销UI-A')>=0})`);

  const n0 = await count();
  push('列表里有自己造的两篇', (await hasA()) === true && n0 >= 2, n0 + ' 行');

  await cdp.js(`(function(){var bs=[].slice.call(document.querySelectorAll('#artTbody [data-artdel]'));var hit=null;bs.forEach(function(b){if(b.closest('tr').textContent.indexOf('撤销UI-A')>=0)hit=b});if(hit)hit.click();return !!hit})()`);
  await new Promise((r) => setTimeout(r, 400));
  const dlg = await cdp.js(`(function(){var d=document.getElementById('delDlg'); return d?d.open:null})()`);
  push('删除前有确认框', dlg === true, dlg);
  await cdp.js(`(function(){document.getElementById('delSubmit').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 1600));

  push('确认后那一篇没了', (await hasA()) === false && (await count()) === n0 - 1, (await count()) + '/' + n0);

  const dis = await cdp.js(`(function(){var b=document.getElementById('artUndo'); return b?b.disabled:null})()`);
  push('「撤销」按钮可用', dis === false, dis);
  await cdp.js(`(function(){document.getElementById('artUndo').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 2000));
  push('撤销后那篇回来了', (await hasA()) === true, await hasA());
  push('撤销后总数恢复', (await count()) === n0, (await count()) + '/' + n0);
} finally {
  await cdp.close();
}

await delById(b1);
const afterUndo = await getList();
const b1Again = afterUndo.filter((a) => a.title === '撤销UI-A').map((a) => String(a.id))[0];
if (b1Again) await delById(b1Again);
await delById(b2);
finish();

function finish() {
  let bad = 0;
  for (const r of rows) {
    if (!r.ok) bad++;
    console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + r.detail : ''));
  }
  console.log('');
  console.log(bad ? bad + ' FAILED of ' + rows.length : 'ALL OK (' + rows.length + ')  @' + BASE + (REMOTE ? ' (REMOTE)' : ''));
  process.exit(bad ? 1 : 0);
}