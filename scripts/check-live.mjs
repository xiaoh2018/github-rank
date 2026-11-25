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


// —— 第 27 轮扩展：核心页面 + 机器可读入口 + 后台友链编辑 ——
const nav = await fetch(base + '/nav?v=' + t);
const navText = await nav.text();
push('/nav 页面', nav.ok && navText.includes('navView') === false ? nav.ok : nav.ok, nav.status);
push('导航分组卡片', navText.includes('navgroup') || navText.includes('navcard'));

const faq = await fetch(base + '/faq?v=' + t);
const faqText = await faq.text();
push('/faq 页面', faq.ok, faq.status);
push('问答带主题引导', faqText.includes('ghrank-theme'));

const llms = await fetch(base + '/llms.txt?v=' + t);
const llmsText = await llms.text();
push('/llms.txt', llms.ok && llmsText.startsWith('# '), llms.status + ' ' + llmsText.length + 'B');

const robots = await fetch(base + '/robots.txt?v=' + t);
const robotsText = await robots.text();
push('/robots.txt 放行 AI', robots.ok && robotsText.includes('User-agent: GPTBot'), robots.status);

const qa = await fetch(base + '/api/qa?v=' + t);
const qaJson = await qa.json().catch(() => null);
const qaItems = (qaJson && qaJson.qa && qaJson.qa.items) || (qaJson && qaJson.items) || [];
push('/api/qa', qa.ok && qaItems.length > 0, qaItems.length + ' 条');

const navApi = await fetch(base + '/api/nav?v=' + t);
const navJson = await navApi.json().catch(() => null);
push('/api/nav', navApi.ok && navJson && navJson.nav && (navJson.nav.groups || []).length > 0, navJson && navJson.nav ? (navJson.nav.groups || []).length + ' 组' : '');

push('后台友链可编辑', adm.includes('data-edit') && adm.includes('addDesc') && adm.includes('addTitle'));
push('后台概览体检', adm.includes('healthBox') && adm.includes('loadHealth'));

// —— 第 34 轮扩展：总榜数据 / 文章封面 / 问答计数 / 健康接口 / 后台三个预览 ——
const total = await fetch(base + '/data/repos-total.js?v=' + t);
const totalText = await total.text();
push('/data/repos-total.js', total.ok && totalText.includes('__GHRANK_RANGES__') && totalText.includes('total'), total.status + ' ' + totalText.length + 'B');

const metaHead = await fetch(base + '/data/repos-meta.js?v=' + t);
const metaCC = metaHead.headers.get('cache-control') || '';
push('版本化数据长缓存', metaHead.ok && metaCC.includes('immutable'), metaCC);

const artPage = await fetch(base + '/articles?v=' + t);
const artText = await artPage.text();
push('/articles 卡片布局', artPage.ok && artText.includes('acard'), artPage.status);
push('文章封面支持', artText.includes('acover') && artText.includes('a.cover'));

push('问答分类计数', faqText.includes('counts[t]') && faqText.includes("chip b"));
push('问答折叠标记', faqText.includes('summary:after') && faqText.includes('content:"+"'));

const health = await fetch(base + '/api/health?v=' + t);
const healthJson = await health.json().catch(() => null);
const hv = healthJson && (healthJson.assetV || healthJson.version || (healthJson.status && healthJson.status.assetV));
push('/api/health', health.ok && !!hv, health.status + ' ' + (hv || ''));

push('后台 SEO 结果预览', adm.includes('serpTitle') && adm.includes('serpDesc'));
push('后台广告预览按钮', adm.includes('data-adprev') && adm.includes('adPrevDlg'));
push('后台二维码预览', adm.includes('contactQrPrev') && adm.includes('contactQrImg'));

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
