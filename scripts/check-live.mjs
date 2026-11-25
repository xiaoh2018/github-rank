// 线上冒烟：核对最近几轮的关键改动是否真的部署上去了
const base = 'https://github.661026.xyz';
const t = Date.now();
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra || '' });

const nf = await fetch(base + '/nope-xyz?v=' + t);
const nfText = await nf.text();
push('404 状态码', nf.status === 404, nf.status);
push('404 是 HTML', (nf.headers.get('content-type') || '').includes('text/html'));
push('404 带导航', nfText.includes('href="/nav"') && nfText.includes('这个页面不存在'));
push('404 不缓存', (nf.headers.get('cache-control') || '').includes('no-store'));

const home = await (await fetch(base + '/?v=' + t)).text();
push('首页弹窗焦点陷阱', home.includes('bindDialogA11y'));
push('首页卡片入场', home.includes('@keyframes cardIn'));
push('首页广告位容器', home.includes('id="adHomeTop"') && home.includes('id="adSidebar"'));

const art = await (await fetch(base + '/articles?v=' + t)).text();
push('文章搜索防抖', art.includes('searchTimer'));
push('文章目录跟随滚动', art.includes('spyToc') && art.includes('a.is-cur'));

const adm = await (await fetch(base + '/admin?v=' + t)).text();
push('后台跳转内容', adm.includes('skip-link'));
push('后台表头吸附', adm.includes('position:sticky'));
push('后台分类管理', adm.includes('catTbody'));
push('后台收录提交', adm.includes('pane-submit'));

const api = await fetch(base + '/api/status?v=' + t);
const apiJson = await api.json();
push('/api/status', api.ok && apiJson && apiJson.configured === true, 'ai=' + (apiJson && apiJson.translator ? apiJson.translator.ai : 'n/a'));

const submit = await (await fetch(base + '/api/submit?v=' + t)).text();
push('/api/submit 明细', submit.includes('keyFileOk'));

const sm = await (await fetch(base + '/sitemap.xml?v=' + t)).text();
push('sitemap 有 .html', sm.includes('.html</loc>') || sm.includes('/articles/'));

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
