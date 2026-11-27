// 收录自查：批量查询（接口 + 后台表格）
import { openCdp } from './lib/cdp.mjs';

const REMOTE = process.env.PROBE_BASE || '';
const BASE = REMOTE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PW || 'dev';
const W = Number(process.env.W || 1440);
let bad = 0;
const ck = (name, ok, extra) => {
  if (!ok) bad++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra ? '  → ' + extra : ''));
};
const post = async (body) => {
  const r = await fetch(BASE + '/api/index-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
};

// ---- 接口侧 ----
const three = await post({ password: PW, urls: ['/', '/articles', '/articles/tech/4.html'] });
ck('批量 3 条 → 200', three.status === 200 && three.j && three.j.ok === true, 'HTTP ' + three.status);
ck('返回 batch=true 且 total=3', !!three.j && three.j.batch === true && three.j.total === 3 && Array.isArray(three.j.items) && three.j.items.length === 3, JSON.stringify(three.j && three.j.summary));
ck('每条都有 path / status / inSitemap / inLastSubmit', !!three.j && three.j.items.every((x) => typeof x.path === 'string' && x.path && typeof x.status === 'number' && (typeof x.inSitemap === 'boolean' || x.inSitemap === null) && typeof x.inLastSubmit === 'boolean'), '');
ck('summary 统计可访问条数', !!three.j && three.j.summary && three.j.summary.okStatus >= 2, JSON.stringify(three.j && three.j.summary));

const many = await post({ password: PW, urls: Array.from({ length: 21 }, (_, i) => '/x' + i) });
ck('21 条 → 400 并说明上限', many.status === 400 && !!many.j && /最多查 20 条/.test(many.j.error || ''), 'HTTP ' + many.status + ' ' + (many.j && many.j.error));

const dup = await post({ password: PW, urls: ['/', '/', '/articles'] });
ck('重复地址会去重', dup.status === 200 && dup.j && dup.j.total === 2, JSON.stringify(dup.j && dup.j.total));

const mixed = await post({ password: PW, urls: ['/', '/no-such-page-xyz'] });
const miss = mixed.j && mixed.j.items && mixed.j.items[1];
ck('混进不存在的地址 → 那一条是 404，整体仍然 ok', mixed.status === 200 && !!miss && miss.status === 404, JSON.stringify(miss && { p: miss.path, s: miss.status }));

const noPw = await post({ urls: ['/'] });
ck('批量也要密码（不带 → 403）', noPw.status === 403, 'HTTP ' + noPw.status);

const out = await post({ password: PW, urls: ['https://example.com/foo'] });
ck('站外地址被拒绝（整条报错）', out.status === 200 && out.j && out.j.items && !!out.j.items[0].error, JSON.stringify(out.j && out.j.items && out.j.items[0]));

// ---- UI 侧（远程模式跳过）----
if (REMOTE) {
  console.log('（线上模式：跳过后台 UI 断言）');
} else {
  const cdp = await openCdp({ width: W, height: 1200 });
  await cdp.init();
  await cdp.goto(BASE + '/admin', 1400);
  await cdp.js(`sessionStorage.setItem('adminPw','${PW}'); 1`);
  await cdp.goto(BASE + '/admin?cb=' + Date.now(), 2400);
  await cdp.js(`(() => { document.querySelector('.side .nav[data-tab="submit"]').click(); return 1; })()`);
  await new Promise((r) => setTimeout(r, 300));
  const hasBatch = await cdp.js(`!!document.getElementById('ickBatch') && !!document.getElementById('ickBatchRun') && !!document.getElementById('ickTable')`);
  ck('后台有批量入口（textarea + 按钮 + 结果区）', hasBatch === true, '');
  const label = await cdp.js(`(() => { const t = document.getElementById('ickBatch'); return t ? t.getAttribute('aria-label') : ''; })()`);
  ck('批量输入框有可访问名', typeof label === 'string' && label.length > 0 && /地址/.test(label), String(label));
  await cdp.js(`(() => { document.querySelector('.ick-batch').open = true; const t = document.getElementById('ickBatch'); t.value = '/\\n/articles\\n/articles/tech/4.html'; document.getElementById('ickBatchRun').click(); return 1; })()`);
  await new Promise((r) => setTimeout(r, 2200));
  const ui = await cdp.js(`(() => {
    const out = document.getElementById('ickTable');
    const rows = out.querySelectorAll('tbody tr');
    const sum = out.querySelector('.ick-sum');
    const wrap = out.querySelector('.ick-tw');
    return {
      rows: rows.length,
      head: [...out.querySelectorAll('th')].map((h) => h.textContent),
      sum: sum ? sum.textContent : '',
      scrollable: !!wrap && getComputedStyle(wrap).overflowX !== 'visible',
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    };
  })()`);
  ck('贴 3 条 → 表格 3 行', ui && ui.rows === 3, JSON.stringify({ rows: ui && ui.rows }));
  ck('表头六列齐全', ui && ui.head && ui.head.join(',') === '地址,HTTP,robots,canonical,在 sitemap,上次提交', JSON.stringify(ui && ui.head));
  ck('有一条汇总说明', ui && /共 3 条/.test(ui.sum) && /可访问/.test(ui.sum), String(ui && ui.sum).slice(0, 60));
  ck('宽表自带横向滚动（不把整页撑开）', ui && ui.scrollable === true && ui.sw === ui.cw, JSON.stringify({ s: ui && ui.sw, c: ui && ui.cw }));
  await cdp.close();
}

console.log('');
if (bad) { console.log(bad + ' FAILED of ' + (bad + 0)); process.exit(1); }
console.log('ALL OK');