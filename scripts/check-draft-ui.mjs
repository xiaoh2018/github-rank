import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = BASE.includes('github.661026.xyz');
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

const post = async (body) =>
  fetch(BASE + '/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ password: 'dev' }, body)),
  }).then((r) => r.json());

if (REMOTE) {
  const html = await (await fetch(BASE + '/admin')).text();
  push('后台有状态筛选下拉', html.includes('id="artDraftFilter"'));
  push('后台概览有草稿入口', html.includes('data-draft-only'));
} else {
  const draftTitle = '草稿筛选测试-' + Date.now();
  const liveTitle = '已发布筛选测试-' + Date.now();
  const a1 = await post({ action: 'add', article: { title: draftTitle, date: '2026-11-30', summary: '测完删掉', body: '', draft: true } });
  const a2 = await post({ action: 'add', article: { title: liveTitle, date: '2026-11-30', summary: '测完删掉', body: '正文', draft: false } });
  const d1 = (a1.articles || []).find((a) => a.title === draftTitle);
  const d2 = (a2.articles || []).find((a) => a.title === liveTitle);

  const cdp = await openCdp({ width: 1440, height: 900 });
  try {
    await cdp.send('Page.navigate', { url: BASE + '/admin' });
    await new Promise((r) => setTimeout(r, 1500));
    await cdp.js(`sessionStorage.setItem('adminPw','dev')`);
    await cdp.js('location.reload()');
    await new Promise((r) => setTimeout(r, 2800));

    const statText = await cdp.js(`(function(){
      var b = document.querySelector('#stDraft [data-draft-only]');
      return b ? { text: b.textContent, hidden: b.hidden } : null;
    })()`);
    push('概览显示草稿数', statText && /1 篇/.test(statText.text), JSON.stringify(statText));

    await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="articles"]'); if(n) n.click(); return 1})()`);
    await new Promise((r) => setTimeout(r, 700));

    const opts = await cdp.js(`Array.from(document.querySelectorAll('#artDraftFilter option')).map(function(o){return o.value})`);
    push('筛选下拉有三个状态', Array.isArray(opts) && opts.join(',') === ',draft,live', JSON.stringify(opts));

    const titles = () => cdp.js(`Array.from(document.querySelectorAll('#artTbody tr td.t-title, #artTbody tr')).map(function(tr){return tr.textContent}).join('|')`);
    const allTxt = await titles();
    push('默认能看到草稿与已发布', allTxt.includes(draftTitle) && allTxt.includes(liveTitle), '');

    await cdp.js(`(function(){
      var s = document.getElementById('artDraftFilter');
      s.value = 'draft'; s.dispatchEvent(new Event('change', {bubbles:true}));
      return s.value;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const dOnly = await titles();
    push('选「仅草稿」只剩草稿', dOnly.includes(draftTitle) && !dOnly.includes(liveTitle), '');
    const note = await cdp.js(`(document.getElementById('artSearchNote')||{}).textContent||''`);
    push('筛选说明里写了「仅草稿」', String(note).includes('仅草稿'), note);

    await cdp.js(`(function(){
      var s = document.getElementById('artDraftFilter');
      s.value = 'live'; s.dispatchEvent(new Event('change', {bubbles:true}));
      return s.value;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const liveOnly = await titles();
    push('选「不含草稿」看不到草稿', liveOnly.includes(liveTitle) && !liveOnly.includes(draftTitle), '');

    await cdp.js(`(function(){ var n=document.querySelector('.side [data-tab="overview"]'); if(n) n.click(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 500));
    await cdp.js(`(function(){var b=document.querySelector('#stDraft [data-draft-only]'); if(b) b.click(); return 1})()`);
    await new Promise((r) => setTimeout(r, 800));
    const jumped = await cdp.js(`(function(){
      var pane = document.getElementById('pane-articles');
      var s = document.getElementById('artDraftFilter');
      return { paneShown: !!pane && getComputedStyle(pane).display !== 'none', filter: s ? s.value : null };
    })()`);
    push('点概览的草稿数跳到文章并自动只看草稿', jumped.paneShown && jumped.filter === 'draft', JSON.stringify(jumped));
    const afterJump = await titles();
    push('跳转后列表只剩草稿', afterJump.includes(draftTitle) && !afterJump.includes(liveTitle), '');

    const ov390 = await cdp.js(`(function(){
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
    })()`);
    push('1440 下整页不横向溢出', ov390.sw <= ov390.cw + 1, JSON.stringify(ov390));
  } finally {
    await cdp.close();
    if (d1) await post({ action: 'remove', id: d1.id });
    if (d2) await post({ action: 'remove', id: d2.id });
  }
  const left = await (await fetch(BASE + '/data/articles.json?v=' + Date.now())).json();
  push('测试数据已清理', !(left || []).some((a) => /筛选测试-/.test(a.title || '')), 'count=' + (left || []).length);
}

const bad = rows.filter((r) => !r.ok);
rows.forEach((r) => console.log((r.ok ? 'OK  ' : 'FAIL') + '   ' + r.label + (r.detail ? '  [' + r.detail + ']' : '')));
console.log('\n' + (bad.length ? bad.length + ' FAILED' : 'ALL OK') + ' (' + rows.length + ')  @' + BASE);
process.exit(bad.length ? 1 : 0);