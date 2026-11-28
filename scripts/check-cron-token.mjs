import { openCdp } from './lib/cdp.mjs';

const base = process.env.PROBE_BASE ? process.env.PROBE_BASE.replace(/\/+$/, '') : 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const PW = process.env.ADMIN_PW || 'dev';
const rows = [];
function ok(name, cond, extra) {
  rows.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) });
}
async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null), text: '' };
}
const seoOf = async () => ((await (await fetch(base + '/api/site')).json()).site || {}).seo || {};

const raw = 'tok_' + Date.now().toString(16) + 'abcdef0123456789';
const s0 = await seoOf();

if (!REMOTE) {
  const r1 = await post('/api/site', { password: PW, section: 'seo', value: Object.assign({}, s0, { indexCronToken: raw }) });
  const s1 = await seoOf();
  ok('保存令牌返回 200', r1.status === 200 && r1.json && r1.json.ok, 'HTTP ' + r1.status);
  ok('只存哈希，且长度是 64 位', /^[0-9a-f]{64}$/.test(String(s1.indexCronTokenHash || '')), String(s1.indexCronTokenHash || '').slice(0, 10));
  ok('明文没有落进站点配置', JSON.stringify(s1).indexOf(raw) < 0, '');
  ok('接口不会把明文回吐', !('indexCronToken' in s1), Object.keys(s1).join(','));

  const r2 = await post('/api/site', { password: PW, section: 'seo', value: { siteName: s0.siteName, title: '改标题验证哈希保留' } });
  const s2 = await seoOf();
  ok('只改标题不会清掉令牌哈希', r2.status === 200 && s2.indexCronTokenHash === s1.indexCronTokenHash, s2.title);

  const r3 = await post('/api/index-cron', { token: raw });
  ok('用原文能跑定时自查（200）', r3.status === 200 && r3.json && r3.json.ok === true, 'HTTP ' + r3.status + ' checked=' + (r3.json && r3.json.checked));

  const r4 = await post('/api/index-cron', { token: 'definitely-wrong' });
  ok('错令牌 → 403', r4.status === 403, 'HTTP ' + r4.status);

  const r5 = await post('/api/site', { password: PW, section: 'seo', value: Object.assign({}, s0, { indexCronToken: 'bad token!' }) });
  ok('带空格/符号的令牌 → 400 并说清规则', r5.status === 400 && /字母|数字/.test(String(r5.json && r5.json.error)), r5.json && r5.json.error);

  const r6 = await post('/api/site', { password: PW, section: 'seo', value: Object.assign({}, s0, { indexCronToken: '' }) });
  const s6 = await seoOf();
  ok('清空令牌 → 哈希变空', r6.status === 200 && !s6.indexCronTokenHash, JSON.stringify(s6.indexCronTokenHash));
  const r7 = await post('/api/index-cron', { token: raw });
  ok('清空后再用原文 → 400 并指路后台', r7.status === 400 && /定时自查|CRON_TOKEN/.test(String(r7.json && r7.json.error)), 'HTTP ' + r7.status);

  // 还原标题
  await post('/api/site', { password: PW, section: 'seo', value: Object.assign({}, s0, { title: s0.title }) });
}

// ---------- 后台 UI ----------
const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: base + '/admin' });
  await new Promise((r) => setTimeout(r, 1500));
  if (!REMOTE) {
    await cdp.js("sessionStorage.setItem('adminPw','dev')");
    await cdp.send('Page.navigate', { url: base + '/admin' });
    await new Promise((r) => setTimeout(r, 2600));
    await cdp.js("(function(){var n=document.querySelector('.side [data-tab=\"submit\"]');if(n)n.click();return 1})()");
    await new Promise((r) => setTimeout(r, 600));
  }
  const ui = await cdp.js(`(function(){
    var w = document.getElementById('cronWrap'); if (w) w.open = true;
    var t = document.getElementById('seo-indexCronToken');
    var g = document.getElementById('cronTokGen');
    var s = document.getElementById('cronTokSave');
    var st = document.getElementById('cronTokState');
    return { hasWrap: !!w, token: !!t, gen: !!g, save: !!s, state: !!st,
             saveSection: s ? s.getAttribute('data-save') : '',
             tokenAria: t ? (t.getAttribute('aria-label') || '') : '',
             stateText: st ? String(st.textContent || '') : '' };
  })()`);
  ok('「定时自查」里有令牌输入框', ui.hasWrap && ui.token, JSON.stringify({ wrap: ui.hasWrap, token: ui.token }));
  ok('令牌框有可访问名', /定时令牌/.test(ui.tokenAria), ui.tokenAria);
  ok('有「生成随机令牌」和「保存令牌」', ui.gen && ui.save, JSON.stringify({ gen: ui.gen, save: ui.save }));
  ok('保存按钮走 seo 段保存', ui.saveSection === 'seo', ui.saveSection);

  if (!REMOTE) {
    const gen = await cdp.js(`(function(){
      var g = document.getElementById('cronTokGen'); if (g) g.click();
      var t = document.getElementById('seo-indexCronToken');
      var st = document.getElementById('cronTokState');
      return { val: t ? String(t.value || '') : '', state: st ? String(st.textContent || '') : '' };
    })()`);
    ok('点「生成」得到一个 32 位十六进制令牌', /^[0-9a-f]{32}$/.test(gen.val), gen.val.slice(0, 12) + '…');
    ok('生成后状态行提示「已填 32 位」', /已填 32 位|保存令牌/.test(gen.state), gen.state.slice(0, 40));
  } else {
    ok('线上：未配置时状态行说清怎么配', /还没配置|已配置/.test(ui.stateText), ui.stateText.slice(0, 40));
  }
} finally {
  await cdp.close();
}

for (const x of rows) console.log((x.ok ? 'OK   ' : 'FAIL ') + x.name + (x.extra ? '  [' + x.extra + ']' : ''));
const bad = rows.filter((x) => !x.ok).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);