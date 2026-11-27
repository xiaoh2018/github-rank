// 收录自查（/api/index-check + 后台卡片）
import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const W = Number(process.env.W || 1440);
const PAGES = (process.env.PW || 'dev');
const rows = [];
const ck = (name, cond, extra) => { rows.push({ name, ok: !!cond, extra: extra === undefined ? '' : extra }); };

const cdp = await openCdp({ width: W, height: 2600 });
try {
  await cdp.init();
  const shot = await fetch(BASE + '/admin?cb=' + Date.now());
  const html = await shot.text();
  ck('后台含收录自查卡片', html.includes('id="indexCheck"'), '');
  ck('后台引用 /api/index-check', html.includes('/api/index-check'), '');

  // 未登录的接口行为（不依赖 CDP）
  const r0 = await fetch(BASE + '/api/index-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: '/' }) });
  ck('没密码 → 403', r0.status === 403, String(r0.status));
  const r1 = await fetch(BASE + '/api/index-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x', url: '/' }) });
  ck('错密码 → 403', r1.status === 403, String(r1.status));

  if (!REMOTE) {
    const r2 = await fetch(BASE + '/api/index-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PAGES, url: '/articles/tech/4.html' }) });
    const j2 = await r2.json();
    ck('自查返回「这批地址」指纹', r2.status === 200 && /^[0-9a-f]{8}$/.test(j2.sigNow || '') && j2.batchCount >= 2, JSON.stringify({ count: j2.batchCount, sig: j2.sigNow }));
    ck('自查解释「为什么跳过」', typeof j2.why === 'string' && /(还没有提交记录|完全一样|不一样了)/.test(j2.why), String(j2.why || '').slice(0, 40));
    ck('sigSame 与提交记录一致', j2.lastAt ? typeof j2.sigSame === 'boolean' : j2.sigSame === null, JSON.stringify({ lastAt: j2.lastAt || '', sigSame: j2.sigSame }));
  }

  if (!REMOTE) {
    await cdp.goto(BASE + '/admin?cb=' + Date.now(), 1800);
    await cdp.js(`sessionStorage.setItem('adminPw', ${JSON.stringify(PAGES)}); 1`);
    await cdp.goto(BASE + '/admin?cb=' + (Date.now() + 1), 2200);
    const entered = await cdp.js(`(() => {
      const gate = document.getElementById('gate');
      return gate ? getComputedStyle(gate).display === 'none' : false;
    })()`);
    ck('已登录（gate 隐藏）', entered, '');
    await cdp.js(`(() => { const nav = [...document.querySelectorAll('.side .nav')].find((n) => n.getAttribute('data-tab') === 'submit'); if (nav) nav.click(); return 1; })()`);
    await cdp.js(`(() => { const w = document.querySelector('[data-go="submit"]'); if (w) w.click(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 400));
    const card = await cdp.js(`(() => {
      const c = document.getElementById('indexCheck');
      const pane = document.getElementById('pane-submit');
      return { has: !!c, paneOpen: pane ? pane.hidden === false : false, vis: c ? getComputedStyle(c).display !== 'none' : false };
    })()`);
    ck('提交面板打开且卡片可见', card && card.has && card.paneOpen && card.vis, JSON.stringify(card));

    // 查首页（留空）
    await cdp.js(`(() => { const i = document.getElementById('ickUrl'); i.value = ''; document.getElementById('ickRun').click(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const home = await cdp.js(`(() => {
      const rows = [...document.querySelectorAll('#ickOut .ick-i')].map((r) => ({ k: r.querySelector('b').textContent, v: r.querySelector('span').textContent, cls: r.className }));
      const links = [...document.querySelectorAll('#ickOut .ick-links a')].map((a) => a.href);
      return { rows, links };
    })()`);
    const keys = (home && home.rows ? home.rows.map((r) => r.k) : []).join('|');
    ck('查出七行（含「这批地址」）', home && home.rows.length === 7, keys);
    ck('「这批地址」带指纹', home && home.rows.some((r) => r.k === '这批地址' && /[0-9a-f]{8}/.test(r.v)), '');
    ck('HTTP 状态 200', home && home.rows.some((r) => r.k === 'HTTP 状态' && r.v === '200'), '');
    ck('canonical 指向自己', home && home.rows.some((r) => r.k === 'canonical' && /指向自己/.test(r.v)), '');
    ck('在 sitemap 里', home && home.rows.some((r) => r.k === '在 sitemap 里' && /^在/.test(r.v)), '');
    ck('四个平台链接', home && home.links.length === 4, (home && home.links || []).length);
    ck('链接含 bing/百度 site: 查询',
      home && home.links.some((u) => u.indexOf('bing.com/search') >= 0) && home.links.some((u) => u.indexOf('baidu.com/s') >= 0), '');

    // 筛选视图 → noindex
    await cdp.js(`(() => { const i = document.getElementById('ickUrl'); i.value = '/?q=x'; document.getElementById('ickRun').click(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const noidx = await cdp.js(`(() => {
      const r = [...document.querySelectorAll('#ickOut .ick-i')].find((x) => x.querySelector('b').textContent === 'robots');
      return r ? { v: r.querySelector('span').textContent, cls: r.className } : null;
    })()`);
    ck('筛选视图 robots 显示 noindex 并标红', noidx && /noindex/i.test(noidx.v) && /bad/.test(noidx.cls), JSON.stringify(noidx));

    // 站外地址
    await cdp.js(`(() => { const i = document.getElementById('ickUrl'); i.value = 'https://example.com/'; document.getElementById('ickRun').click(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 1200));
    const bad = await cdp.js(`(() => { const p = document.querySelector('#ickOut p'); return p ? p.textContent : ''; })()`);
    ck('站外地址给出人话拒绝', /只能检查本站地址/.test(bad || ''), String(bad).slice(0, 40));

    const noOverflow = await cdp.js(`(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))()`);
    ck('不横向溢出', noOverflow && noOverflow.sw <= noOverflow.cw + 1, JSON.stringify(noOverflow));
  } else {
    ck('线上：接口需要密码', true, 'skip-ui');
  }
} finally {
  await cdp.close();
}

let bad = 0;
for (const r of rows) {
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  → ' + r.extra : ''));
  if (!r.ok) bad++;
}
console.log(bad ? bad + ' FAILED of ' + rows.length : 'ALL OK (' + rows.length + ')');
process.exit(bad ? 1 : 0);