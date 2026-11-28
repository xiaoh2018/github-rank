// 演练（试推）必须真的不发外部请求：IndexNow 按频率限流，百度普通收录有每日额度。
// 这里既验接口返回的 dry 字段，也用 CDP 在外发请求那一层数「有没有真的发出去」。
import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail });

async function post(body) {
  const r = await fetch(BASE + '/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j = null;
  try {
    j = await r.json();
  } catch (e) {}
  return { status: r.status, j };
}

// ---- 接口 ----
if (!REMOTE) {
  const noPw = await post({ test: true });
  push('演练也要口令（不带口令 403）', noPw.status === 403, 'HTTP ' + noPw.status);

  const r = await post({ password: 'dev', test: true });
  const in1 = r.j && r.j.results && r.j.results.indexNow;
  const bd = r.j && r.j.results && r.j.results.baidu;
  push('演练返回 ok 且标了 dry', r.status === 200 && r.j.ok === true && r.j.dry === true, 'HTTP ' + r.status + ' dry=' + (r.j && r.j.dry));
  push('IndexNow 结果是演练（dry + status 0）', in1 && in1.dry === true && in1.status === 0, JSON.stringify(in1 && { dry: in1.dry, status: in1.status }));
  push('百度结果是演练（dry + status 0）', bd && bd.dry === true && bd.status === 0, JSON.stringify(bd && { dry: bd.dry, status: bd.status }));
  push('文案说清「没有真的推」', /没有真的推/.test(String(in1 && in1.note)) && /没有真的推/.test(String(bd && bd.note)), String(in1 && in1.note));
  push('诊断级别是 warn、且不给重试按钮（演练没什么可重试）', in1 && in1.diag && in1.diag.level === 'warn' && in1.diag.retry === false, JSON.stringify(in1 && in1.diag));
  push('总览把两项算成 warn（不是 fail）', r.j.summary && r.j.summary.warn === 2 && r.j.summary.fail === 0 && r.j.summary.retriable === 0, JSON.stringify(r.j && r.j.summary));
  push('演练不写「上次提交」（否则会污染真实记录）', !r.j.at || r.j.dry === true, 'at=' + (r.j && r.j.at));
} else {
  const noPw = await post({ test: true });
  push('线上演练也要口令（不带口令 403）', noPw.status === 403, 'HTTP ' + noPw.status);
}

// ---- 后台 UI：按钮文案 + 点了以后的结果 + 真的没外发 ----
const hits = [];
const cdp = await openCdp({
  width: 1440,
  height: 900,
  onEvent: (m) => {
    if (m.method === 'Fetch.requestPaused') {
      const u = m.params.request.url;
      hits.push(u);
      cdp.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  },
});
try {
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*api.indexnow.org*', requestStage: 'Request' },
      { urlPattern: '*baidu.com*', requestStage: 'Request' },
    ],
  });

  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  if (!REMOTE) {
    await cdp.js('location.reload()');
    await new Promise((r) => setTimeout(r, 2600));
    await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]');if(n)n.click();return 1})()`);
    await new Promise((r) => setTimeout(r, 600));
  }

  const txt = await cdp.js(`(function(){var b=document.getElementById('subTest');return b? b.textContent.trim():'NONE'})()`);
  push('按钮文案是「演练（不发请求）」', /演练/.test(txt) && /不发请求/.test(txt), txt);

  if (!REMOTE) {
    const before = hits.length;
    await cdp.js(`(function(){var b=document.getElementById('subTest');if(b)b.click();return 1})()`);
    await new Promise((r) => setTimeout(r, 2500));
    const seen = await cdp.js(`(function(){
      var out=document.getElementById('subOut');
      return {dry: !!document.querySelector('.sub-dry'), sum: (document.querySelector('.sub-sum')||{}).textContent||'', hasNext: !!document.querySelector('#subOut a[href]'), text: (document.getElementById('subOut')||{}).textContent||''};
    })()`);
    push('点完出现「演练」提示条', seen.dry === true, JSON.stringify(seen));
    push('总览显示 2 项 warn、0 项失败', /2 项/.test(seen.sum) && !/失败/.test(seen.sum), seen.sum);
    push('每项标题写「演练 · 未发送」而不是「已接收」', /演练 · 未发送/.test(seen.text) && !/已接收/.test(seen.text), (seen.text.match(/演练 · 未发送/g) || []).length + ' 处');
    push('演练期间没有向 IndexNow 发请求（CDP 拦截命中 0）', hits.length === before, 'hits=' + (hits.length - before));
  }

  const sw = await cdp.js('(function(){return {sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}})()');
  push('1440 不横向溢出', sw.sw <= sw.cw + 1, JSON.stringify(sw));
} finally {
  await cdp.close();
}

// 线上只验「文案在位」，不点提交（避免给生产站点留无意义的演练记录）
if (REMOTE) {
  const html = await (await fetch(BASE + '/admin')).text();
  push('后台 HTML 有「演练（不发请求）」', /演练（不发请求）/.test(html), 'len=' + html.length);
  push('后台 HTML 有演练提示样式 .sub-dry', /\.sub-dry\{/.test(html), '');
}

const failed = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + r.detail : ''));
if (failed.length) {
  console.log('\n' + failed.length + ' FAILED of ' + rows.length);
  process.exit(1);
}
console.log('\nALL OK (' + rows.length + ')  @' + BASE);