import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const st = await (await fetch(BASE + '/api/status')).json();
  const bundle = await (await fetch(BASE + '/js/bundle.js?v=' + st.version)).text();
  push('bundle 里有「新进 / 掉出」逻辑', bundle.includes('function paintChurn') && bundle.includes('churnBar'));
  finish();
}

const cdp = await openCdp({ width: 1440, height: 950 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await new Promise((r) => setTimeout(r, 3600));

  const seed = await cdp.js(`(function(){
    var key = window.__snapKey();
    var list = JSON.parse(localStorage.getItem(key) || '[]');
    var base = list[0] && list[0].repos ? list[0].repos : null;
    if (!base || base.length < 5) return {err:'no snapshot', n: base ? base.length : 0};
    var keep = base.slice();
    var removed = keep.splice(0, 3).map(function(r){return r.n});
    keep.push({n:'zzz/fake-one', s: 1}, {n:'zzz/fake-two', s: 1});
    localStorage.setItem(key, JSON.stringify([{t: Date.now() - 25 * 3600 * 1000, repos: keep}]));
    return {key:key, removed:removed, total: keep.length};
  })()`);
  push('已造一份 25 小时前的快照（比现在多 2 个假项目、少 3 个真的）', !seed.err, JSON.stringify(seed).slice(0, 160));

  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 4000));

  const bar = await cdp.js(`(function(){var b=document.getElementById('churnBar');return b? b.textContent : ''})()`);
  push('列表上方出现「较 N 小时前」条', /较\s*2[456]\s*小时前的记录/.test(bar), bar.slice(0, 80));
  push('新进 3 个', /新进\s*3\s*个/.test(bar), bar.slice(0, 80));
  push('掉出 2 个', /掉出\s*2\s*个/.test(bar), bar.slice(0, 80));

  await cdp.js(`(function(){var b=document.getElementById('churnMore'); if(b) b.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 400));
  const det = await cdp.js(`(function(){var d=document.getElementById('churnList');return d? {hidden:d.hidden, text:d.textContent} : null})()`);
  push('点「看是哪几个」能展开名单', det && det.hidden === false && /fake-one/.test(det.text || ''), JSON.stringify(det).slice(0, 120));

  await cdp.js(`(function(){var b=[].find.call(document.querySelectorAll('#ranges .btn'),function(x){return /30/.test(x.textContent)}); if(b) b.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 2500));
  const after = await cdp.js(`(function(){var b=document.getElementById('churnBar');return b? b.textContent : ''})()`);
  push('换到「近 30 天」后不会拿旧数字冒充', !after || !/新进\s*3\s*个/.test(after), after.slice(0, 60));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 800));
  const m = await cdp.js(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})`);
  push('390 下不横向溢出', m.sw <= m.cw + 1, m.sw + '/' + m.cw);
} finally {
  await cdp.close();
}
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