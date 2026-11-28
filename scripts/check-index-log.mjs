// 收录自查历史（/api/index-log）：接口 + 后台「最近查询记录」块
// 本地：node scripts/check-index-log.mjs
// 线上：REMOTE=1 PROBE_BASE=https://github.661026.xyz ADMIN_PW=… node scripts/check-index-log.mjs
import { openCdp } from './lib/cdp.mjs';

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const PW = process.env.ADMIN_PW || 'dev';
const REMOTE = !!process.env.PROBE_BASE;
let bad = 0;
const rows = [];
const ok = (name, cond, detail) => { rows.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) }); if (!cond) bad++; };

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

if (!REMOTE) {
  const cleared = await post('/api/index-log', { password: PW, action: 'clear' });
  ok('清空记录 → total 0', cleared.status === 200 && cleared.j && cleared.j.total === 0, cleared.j && cleared.j.total);

  const c1 = await post('/api/index-check', { password: PW, url: '/articles' });
  ok('查一次 /articles 成功', c1.status === 200 && c1.j && c1.j.ok === true, c1.status);

  const l1 = await post('/api/index-log', { password: PW });
  ok('日志里出现 1 条', l1.j && l1.j.total === 1, l1.j && l1.j.total);
  ok('记下了路径与状态', !!(l1.j && l1.j.entries[0] && l1.j.entries[0].path === '/articles' && l1.j.entries[0].status === 200), l1.j && JSON.stringify(l1.j.entries[0] && { path: l1.j.entries[0].path, status: l1.j.entries[0].status }));
  ok('首次查询没有对照（delta 为 null）', !!(l1.j && l1.j.entries[0].deltaSitemap === null), l1.j && l1.j.entries[0].deltaSitemap);
  ok('响应里带保留上限 50', !!(l1.j && l1.j.cap === 50), l1.j && l1.j.cap);

  await post('/api/index-check', { password: PW, url: '/articles' });
  const l2 = await post('/api/index-log', { password: PW });
  ok('再查一次 → 2 条，新的在前', !!(l2.j && l2.j.total === 2 && l2.j.entries[0].path === '/articles'), l2.j && l2.j.total);
  ok('第二次与上次比：sitemap 没变化', !!(l2.j && l2.j.entries[0].deltaSitemap === 'same'), l2.j && l2.j.entries[0].deltaSitemap);
  ok('老的那条仍是无对照', !!(l2.j && l2.j.entries[1].deltaSitemap === null), '');

  const c3 = await post('/api/index-check', { password: PW, url: '/nope-404' });
  ok('查不存在路径 → 404 也会记下来', !!(c3.j && c3.j.status === 404), c3.j && c3.j.status);
  const l3 = await post('/api/index-log', { password: PW });
  ok('最新一条是 404 且不在 sitemap', !!(l3.j && l3.j.entries[0].path === '/nope-404' && l3.j.entries[0].status === 404 && l3.j.entries[0].inSitemap === false), l3.j && JSON.stringify({ p: l3.j.entries[0].path, s: l3.j.entries[0].status, sm: l3.j.entries[0].inSitemap }));

  const noPw = await post('/api/index-log', { password: 'wrong' });
  ok('密码错 → 403', noPw.status === 403, noPw.status);
}

// 后台 UI：打开收录面板 → 展开「最近查询记录」→ 有表格行
{
  const cdp = await openCdp({ width: 1440, height: 900 });
  try {
    await cdp.send('Page.navigate', { url: BASE + '/admin' });
    await cdp.waitReady?.();
    await new Promise((r) => setTimeout(r, 1500));
    const setup = await cdp.js(`(function(){
      sessionStorage.setItem('adminPw', ${JSON.stringify(PW)});
      return 'ok';
    })()`);
    ok('能写入后台口令', setup === 'ok', setup);
    await cdp.js(`location.reload()`);
    await new Promise((r) => setTimeout(r, 2500));
    const pane = await cdp.js(`(function(){
      var side = document.querySelector('.side');
      if (side) {
        var nav = side.querySelector('[data-tab="submit"]');
        if (nav) nav.click();
      }
      var p = document.getElementById('pane-submit');
      return p ? getComputedStyle(p).display : 'none';
    })()`);
    ok('收录面板能打开', pane !== 'none', pane);
    const opened = await cdp.js(`(function(){
      var w = document.getElementById('ickLogWrap');
      if (!w) return 'no-wrap';
      w.open = true;
      w.dispatchEvent(new Event('toggle'));
      return 'opened';
    })()`);
    ok('「最近查询记录」块存在并可展开', opened === 'opened', opened);
    await new Promise((r) => setTimeout(r, 1200));
    const box = await cdp.js(`(function(){
      var b = document.getElementById('ickLogBox');
      if (!b) return 'no-box';
      var trs = b.querySelectorAll('tr');
      return trs.length + '|' + (b.textContent || '').slice(0, 80);
    })()`);
    const trCount = Number(String(box).split('|')[0]);
    if (REMOTE) {
      ok('线上记录表可用（行数不设下限，线上多半是空的）', trCount >= 0, box);
    } else {
      ok('记录表里有数据行', trCount >= 2, box);
    }
    if (!REMOTE) {
      const hasDelta = await cdp.js(`(function(){
        var b = document.getElementById('ickLogBox');
        return b ? /没变化|新进 sitemap|掉出 sitemap|首次/.test(b.textContent || '') : false;
      })()`);
      ok('表格写明了「和上次比」的结论', hasDelta === true, hasDelta);
    }
  } finally {
    await cdp.close();
  }
}

for (const r of rows) console.log((r.ok ? '  OK   ' : '  FAIL ') + r.name + (r.detail ? '  → ' + r.detail : ''));
console.log(bad ? `\n${bad} FAILED of ${rows.length}` : `\nALL OK (${rows.length})  @${BASE}`);
process.exit(bad ? 1 : 0);