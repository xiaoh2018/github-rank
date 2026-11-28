// 收录记录的趋势摘要：今天 vs 昨天 + 挂着的清单 + 一键填
import { openCdp } from './lib/cdp.mjs';

const REMOTE = !!process.env.PROBE_BASE;
const BASE = REMOTE ? process.env.PROBE_BASE.replace(/\/$/, '') : 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PW || 'dev';
const rows = [];
function ok(name, cond, extra) {
  rows.push({ name, ok: !!cond, extra: extra == null ? '' : String(extra) });
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

if (!REMOTE) {
  await post('/api/index-log', { password: PW, action: 'clear' });
  await post('/api/index-check', { password: PW, url: '/nope-trend-404' });
  await post('/api/index-check', { password: PW, url: '/articles' });
  const j = (await post('/api/index-log', { password: PW })).json || {};
  const sm = j.summary || {};
  ok('接口返回 summary', !!j.summary, JSON.stringify(Object.keys(sm)));
  ok('今天查了 2 次', sm.today === 2, sm.today);
  ok('昨天 0 次（刚清空过）', sm.yesterday === 0, sm.yesterday);
  ok('新出问题 1 条', sm.newToday === 1, sm.newToday);
  ok('修好是数字（今天没修好就是 0）', typeof sm.fixedToday === 'number', sm.fixedToday);
  const open = Array.isArray(sm.openIssues) ? sm.openIssues : [];
  ok('挂着的清单里有 404 那条', open.some((o) => o.path === '/nope-trend-404' && o.status === 404), JSON.stringify(open.map((o) => o.path)));
  ok('200 那条不在挂着清单里', !open.some((o) => o.path === '/articles'), JSON.stringify(open.map((o) => o.path)));
  ok('挂着的那条标了 isNew', open.every((o) => typeof o.isNew === 'boolean'), open.map((o) => o.isNew).join(','));
}

const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await cdp.js(`sessionStorage.setItem('adminPw','${PW}')`);
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2600));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]');if(n)n.click();return 1})()`);
  await new Promise((r) => setTimeout(r, 600));
  await cdp.js(`(function(){var w=document.getElementById('ickLogWrap');if(w){w.open=true;w.dispatchEvent(new Event('toggle'));}return w?'ok':'no'})()`);
  await new Promise((r) => setTimeout(r, 1600));

  const bar = await cdp.js(`(function(){
    var b = document.getElementById('ickTrend');
    return b ? { n: b.querySelectorAll('.ick-tag').length, text: b.textContent || '', btn: !!b.querySelector('[data-ickfill]') } : null;
  })()`);
  if (!REMOTE) {
    ok('趋势条有 5 个标签', bar && bar.n === 5, bar && bar.n);
    ok('趋势条写了今天查了几次', !!(bar && /今天查了/.test(bar.text)), bar && bar.text.slice(0, 60));
    ok('趋势条写了还挂着几条', !!(bar && /还挂着/.test(bar.text)), bar && bar.text);
  }
  if (REMOTE) {
    // 线上没有后台口令：/api/index-log 返回 403，面板只显示「读不到记录：密码不对」，
    // 趋势条本来就是空的。这里只验「容器与文案都部署上去了」，不假装验过数据。
    const dom = await cdp.js(`(function(){
      var t = document.getElementById('ickTrend');
      var b = document.getElementById('ickLogBox');
      return { hasTrend: !!t, cls: t ? t.className : '', box: b ? (b.textContent || '').slice(0, 40) : '' };
    })()`);
    ok('趋势条容器在（#ickTrend）', dom.hasTrend === true && /ick-trend/.test(dom.cls), JSON.stringify(dom));
    ok('没口令时记录区显示「读不到记录」', /读不到记录/.test(dom.box || ''), dom.box);
  }

  if (!REMOTE) {
    const filled = await cdp.js(`(function(){
      var btn = document.querySelector('#ickTrend [data-ickfill]');
      if (!btn) return { err: 'no-btn' };
      btn.click();
      var bi = document.getElementById('ickBatch');
      var msg = document.getElementById('ickActMsg');
      return { value: bi ? bi.value : '', msg: msg ? msg.textContent : '' };
    })()`);
    ok('点一下把挂着的地址填进批量框', /\/nope-trend-404/.test(filled.value || ''), (filled.value || '').slice(0, 60));
    ok('填完给出下一步提示', /批量查/.test(filled.msg || ''), filled.msg);
  } else {
    ok('（线上不点写操作，只验趋势条）', true, 'REMOTE');
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise((r) => setTimeout(r, 700));
  const m = await cdp.js(`(function(){
    return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  })()`);
  ok('390 下整页不横向溢出', m.sw <= m.cw + 1, JSON.stringify(m));
} finally {
  await cdp.close();
}

for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
const bad = rows.filter((r) => !r.ok).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);