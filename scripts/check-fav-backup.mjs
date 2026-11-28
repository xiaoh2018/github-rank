// 收藏只存在这台设备的浏览器里：这轮要证明「用户知道自己在哪、备份过没、丢了怎么恢复」。
import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail });

let cdpRef = null;
const onEvent = (m) => {
  if (m && m.method === 'Page.javascriptDialogOpening' && cdpRef) {
    cdpRef.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  }
};
const cdp = await openCdp({ width: 1440, height: 1000, onEvent });
cdpRef = cdp;
try {
  await cdp.send('Page.enable').catch(() => {});
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await new Promise((r) => setTimeout(r, 2200));

  // 干净起点
  await cdp.js(`localStorage.removeItem('ghrank:favs'); localStorage.removeItem('ghrank:favs-exported'); localStorage.removeItem('ghrank:favs-exported-at'); 1`);
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2200));

  const opened = await cdp.js(`(function(){var b=document.getElementById('btnSettings'); if(b) b.click(); var s=document.getElementById('settings'); return s && !s.hidden})()`);
  push('设置面板能打开', opened, String(opened));

  const hasUi = await cdp.js(`(function(){return {stat: !!document.getElementById('favStat'), clear: !!document.getElementById('btnFavClear'), exp: !!document.getElementById('btnFavExport')}})()`);
  push('「数据」卡里有状态行 + 导出 + 清空三个入口', hasUi.stat && hasUi.clear && hasUi.exp, JSON.stringify(hasUi));

  const empty = await cdp.js(`(function(){var b=document.getElementById('favStat');return b?b.textContent:''})()`);
  push('没有收藏时说明「收藏只在这台设备上」', /还没有收藏/.test(empty) && /这台设备/.test(empty), empty);

  // 收藏两个
  await cdp.js(`(function(){var bs=[...document.querySelectorAll('#list .item .fav')].slice(0,2); bs.forEach(function(b){b.click()}); return bs.length})()`);
  await new Promise((r) => setTimeout(r, 400));
  const two = await cdp.js(`(function(){var b=document.getElementById('favStat');return b?b.textContent:''})()`);
  push('收藏两个后显示「2 个收藏」', /2 个收藏/.test(two), two);
  push('没备份过时明确提醒会丢', /还没备份过/.test(two) && /清缓存|换浏览器/.test(two), two);

  // 导出
  const exp = await cdp.js(`(function(){document.getElementById('btnFavExport').click(); return localStorage.getItem('ghrank:favs-exported-at')})()`);
  await new Promise((r) => setTimeout(r, 400));
  const afterExp = await cdp.js(`(function(){var b=document.getElementById('favStat');return b?b.textContent:''})()`);
  push('点「导出收藏」记下备份时间', !!exp && Number(exp) > 0, String(exp));
  push('备份后状态变成「已备份」', /已备份/.test(afterExp) && !/还没备份过/.test(afterExp), afterExp);

  // 再取消一个 → 又出现「还有改动」
  await cdp.js(`(function(){var b=document.querySelector('#list .item .fav'); if(b) b.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 400));
  const dirty = await cdp.js(`(function(){var b=document.getElementById('favStat');return b?b.textContent:''})()`);
  push('备份后又改动会提示「之后还有改动」', /之后还有改动/.test(dirty), dirty);

  // 合并导入（门禁用钩子，避免真的操作文件选择框）
  const merged = await cdp.js(`JSON.stringify(window.__favMerge(['foo/bar','foo/bar','baz/qux'],'test.json'))`);
  const m = JSON.parse(merged || '{}');
  push('导入是合并（重复项不重复计数）', m.inFile === 2 && m.added === 2, merged);
  const msg = await cdp.js(`(function(){var el=document.querySelector('#status, .status, #toast'); return el?el.textContent:''})()`);
  push('导入后说清「合并进几个」', /合并进 2 个新收藏/.test(msg), msg.slice(0, 80));

  // 清空（confirm 自动确定）
  const cleared = await cdp.js(`(function(){document.getElementById('btnFavClear').click(); return localStorage.getItem('ghrank:favs')})()`);
  await new Promise((r) => setTimeout(r, 500));
  const afterClear = await cdp.js(`(function(){var b=document.getElementById('favStat');return b?b.textContent:''})()`);
  push('清空后本地收藏真的没了', cleared === null, String(cleared));
  push('清空后状态回到空态文案', /还没有收藏/.test(afterClear), afterClear);

  const of = await cdp.js(`(function(){return {sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth}})()`);
  push('1440 下不横向溢出', of.sw <= of.cw + 1, JSON.stringify(of));
} finally {
  await cdp.close();
}

for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + String(r.detail).slice(0, 120) : ''));
const bad = rows.filter((r) => !r.ok);
if (bad.length) {
  console.log('\n' + bad.length + ' FAILED of ' + rows.length);
  process.exit(1);
}
console.log('\nALL OK (' + rows.length + ')  @' + BASE + (REMOTE ? ' (REMOTE)' : ''));