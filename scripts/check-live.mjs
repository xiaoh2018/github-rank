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
const homeRes = await fetch(base + '/?hdr=' + t);
const hcsp = homeRes.headers.get('content-security-policy') || '';
push('线上有 CSP 且禁止被外站嵌套', /frame-ancestors 'self'/.test(hcsp), hcsp.slice(0, 42));
push('线上 X-Content-Type-Options = nosniff', homeRes.headers.get('x-content-type-options') === 'nosniff', String(homeRes.headers.get('x-content-type-options')));
push('线上 X-Frame-Options = SAMEORIGIN', (homeRes.headers.get('x-frame-options') || '') === 'SAMEORIGIN', String(homeRes.headers.get('x-frame-options')));
push('线上有 HSTS（https 一年）', /max-age=31536000/.test(homeRes.headers.get('strict-transport-security') || ''), String(homeRes.headers.get('strict-transport-security')));
push('线上 Referrer-Policy 已设', !!(homeRes.headers.get('referrer-policy') || ''), String(homeRes.headers.get('referrer-policy')));
push('首页三个控件有可访问名（Token / 两个排序）',
  home.includes('aria-label="GitHub Token（只存在你自己的浏览器里）"') &&
  home.includes('aria-label="排序方式（榜单）"') &&
  home.includes('aria-label="排序方式（文章）"'),
  '');
push('文章弹窗密码框有可访问名', home.includes('aria-label="文章访问密码"'), '');
push('页头窄屏按可见按钮数排版（4 个排 2×2，不留孤儿）', home.includes('data-hbtn') && home.includes('.head-actions[data-hbtn="4"]{grid-template-columns:repeat(2,minmax(0,1fr))}'), '');
push('联系面板是 dialog 且可聚焦（tabindex=-1）', home.indexOf('role="dialog" tabindex="-1" aria-labelledby="contactTitle"') >= 0, '');
push('联系按钮 aria-controls 指向真实面板', home.indexOf('aria-controls="contactPanel"') >= 0 && home.indexOf('id="contactPanel"') >= 0, '');
push('打开联系面板时把焦点移进面板', home.indexOf('var contactBack=null') >= 0 && home.indexOf('first.focus()') >= 0, '');
push('关闭联系面板时把焦点还回打开者', home.indexOf('contactBack.focus()') >= 0, '');
  const linksRaw = (await (await fetch(base + '/data/links.json')).text()).trim();
  push('友链数据没有占位条目（已清成 []）', linksRaw.replace(/\s+/g, '') === '[]', linksRaw.slice(0, 40));
  push('友链卡片空态会整块隐藏', home.includes('if(!n){ box.hidden=true; return; }'), '');
  push('友链在新标签打开并带 noopener', home.includes("a.rel='noopener nofollow'") && home.includes("a.target='_blank'"), '');
const siteCfg = await (await fetch(base + '/api/site?t=' + t)).json();
const adCfg = ((siteCfg && siteCfg.site) || siteCfg || {}).ad || {};
push('顶部滚动条是关的、文案为空（没有占位广告）', !!adCfg.ticker && adCfg.ticker.enabled === false && String(adCfg.ticker.text || '') === '', adCfg.ticker);
push('首页的滚动条容器默认隐藏', home.includes('id="adTicker" hidden'), '');
push('隐藏的滚动条不占高度（CSS 兜底在）', home.includes('.ad-ticker[hidden]{display:none!important'), '');
push('切视图会改标签页标题（榜单保留服务器那条）', home.includes('VIEW_TITLES') && home.includes("nav:'站点导航") && home.includes('window.__rankTitle'), '');
push('有读屏播报区（aria-live + 视觉隐藏）', home.includes('id="viewLive" aria-live="polite"') && home.includes('.sr{position:absolute;width:1px'), '');
push('切换时写 document.title 与播报文案', home.includes("document.title = v2==='rank'") && home.includes("'已切换到'"), '');
push('首页弹窗焦点陷阱', home.includes('bindDialogA11y'));
push('首页卡片入场', home.includes('@keyframes cardIn'));
push('首页广告位容器', home.includes('id="adHomeTop"') && home.includes('id="adSidebar"'));
push('首页尊重「减少动态效果」', home.includes('window.__sb') && home.includes('prefers-reduced-motion'));
push('导航图标声明 16×16', home.includes('width="16" height="16"'));

const bundleJs = await (await fetch(base + '/js/bundle.js?v=' + t)).text();
push('榜单列表末尾不再追一条广告', bundleJs.indexOf('pageNodes.pop()') > 0 && bundleJs.indexOf("contains('ad-inline')") > 0, '');
push('文章卡网格末尾不再追一条广告', home.indexOf('grid.lastElementChild.remove()') > 0, '');
push('导航分组末尾不再追一条广告', home.indexOf('idx+1<vis.length') > 0, '');
push('收藏星暴露 aria-pressed（初始 + 点击后）', bundleJs.includes("fav.setAttribute('aria-pressed', String(!!faved))") && bundleJs.includes("fav.setAttribute('aria-pressed', String(on))"), '');
push('榜单三档 / 时间四档同步 aria-pressed', bundleJs.includes("b.setAttribute('aria-pressed', String(on))"), '');
push('「只看收藏」有初始与切换后的 aria-pressed', bundleJs.includes("$('btnFavFilter').setAttribute('aria-pressed', String(state.favOnly))"), '');
push('手机上有「分享」（系统分享面板，退回复制）', bundleJs.includes('async function shareRepo(') && bundleJs.includes('navigator.share('), '');
push('「分享」只在窄屏出现（桌面隐藏）', home.includes('#list .item .mshare-row{display:none') && home.includes('#list .item .mini.mshare{display:inline-flex'), '');
push('「分享」有带项目名的可访问名 + 32px 触摸高度', bundleJs.includes("'分享「' + (r.name || '项目') + '」'") && home.includes('min-height:32px;padding:0 10px'), '');
push('bundle 平滑滚动走 __sb 助手', bundleJs.includes('behavior: window.__sb()'));
push('头像声明 22×22 并异步解码', bundleJs.includes('img.width = 22') && bundleJs.includes("img.decoding = 'async'"));
push('对话框 aria-modal + 焦点圈', home.includes('aria-modal') && home.includes('__bindDlgA11y'));
push('对话框 Esc 与 × 同一关闭路径', home.includes('走与「×」相同的关闭路径'));
push('语言按钮写清「描述」而不是笼统的 English', home.includes('id="btnLang" type="button" aria-pressed="false"') && home.includes('描述：中文'), '');
push('切到原文后状态行说明只管描述', bundleJs.includes('描述：原文') && bundleJs.includes('项目描述已切换为 GitHub 原文'), '');
const artApi = await (await fetch(base + '/api/articles?v=' + t)).text();
const art = await (await fetch(base + '/articles?v=' + t)).text();
push('文章搜索防抖', art.includes('searchTimer'));
push('文章目录跟随滚动', art.includes('spyToc') && art.includes('a.is-cur'));

const adm = await (await fetch(base + '/admin?v=' + t)).text();
push('后台跳转内容', adm.includes('skip-link'));
push('后台表头吸附', adm.includes('position:sticky'));
push('后台分类管理', adm.includes('catTbody'));
push('后台收录提交', adm.includes('pane-submit'));
push('/api/articles 带旧地址计数', artApi.includes('"prevCount"'), '');
push('后台提示「旧地址 N 个（已 301）」', adm.includes('个（已 301）'), '');

const api = await fetch(base + '/api/status?v=' + t);
const apiJson = await api.json();
push('/api/status', api.ok && apiJson && apiJson.configured === true, 'ai=' + (apiJson && apiJson.translator ? apiJson.translator.ai : 'n/a'));
const rankRes = await fetch(base + '/api/rank?limit=2&v=' + t, { headers: { 'cache-control': 'no-cache' } });
let rankJson = null;
try { rankJson = await rankRes.json(); } catch (e) { rankJson = null; }
push('/api/rank 可用（机器可读排行）', rankRes.ok && !!rankJson && rankJson.ok === true && rankJson.total > 0 && Array.isArray(rankJson.items) && rankJson.items.length === 2, rankRes.status + ' total=' + (rankJson && rankJson.total));
push('/api/rank 边缘缓存 5 分钟 + 允许跨域', !!rankRes.headers.get('cache-control') && rankRes.headers.get('cache-control').includes('s-maxage=300') && rankRes.headers.get('access-control-allow-origin') === '*', (rankRes.headers.get('cache-control') || '') + ' | ' + (rankRes.headers.get('access-control-allow-origin') || ''));
const rankTsv = await fetch(base + '/api/rank?limit=2&format=tsv&v=' + t, { headers: { 'cache-control': 'no-cache' } });
const rankTsvLines = (await rankTsv.text()).trim().split(String.fromCharCode(10));
const tsvHead = ['rank', 'name', 'stars', 'forks', 'lang', 'topics', 'desc', 'url'].join(String.fromCharCode(9));
push('/api/rank 支持 format=tsv（表头 + limit+1 行）', rankTsv.ok && /^text\/tab-separated-values/.test(rankTsv.headers.get('content-type') || '') && rankTsvLines[0] === tsvHead && rankTsvLines.length === 3, rankTsvLines.length);
const rankTopic = await fetch(base + '/api/rank?limit=100&topic=desktop-app&v=' + t, { headers: { 'cache-control': 'no-cache' } });
const rankTopicJson = await rankTopic.json().catch(() => null);
push('/api/rank 支持 topic 过滤', rankTopic.ok && !!rankTopicJson && rankTopicJson.topic === 'desktop-app' && rankTopicJson.total > 0 && rankTopicJson.items.every((x) => (x.topics || []).some((y) => String(y).toLowerCase() === 'desktop-app')), rankTopicJson && rankTopicJson.total);

const submit = await (await fetch(base + '/api/submit?v=' + t)).text();
push('/api/submit 明细', submit.includes('keyFileOk'));

const sm = await (await fetch(base + '/sitemap.xml?v=' + t)).text();
push('sitemap 有 .html', sm.includes('.html</loc>') || sm.includes('/articles/'));


// —— 第 27 轮扩展：核心页面 + 机器可读入口 + 后台友链编辑 ——
const nav = await fetch(base + '/nav?v=' + t);
const navText = await nav.text();
push('/nav 页面', nav.ok && navText.includes('navView') === false ? nav.ok : nav.ok, nav.status);
push('导航分组卡片', navText.includes('navgroup') || navText.includes('navcard'));
push('导航页有分类快捷跳转', navText.includes('navjump') && navText.includes('class="nj"'));

const faq = await fetch(base + '/faq?v=' + t);
const faqText = await faq.text();
push('/faq 页面', faq.ok, faq.status);
push('问答带主题引导', faqText.includes('ghrank-theme'));

// 所有 HTML 页面的边缘缓存必须是「几分钟」级：以前 /faq 掉进了 js/css 那一档（24 小时 + swr 7 天），
// 改完一天才生效。这里用带 ?v= 的地址读头（绕过旧边缘对象），守住这条策略。
const htmlTtl = [];
for (const p of ['/', '/articles', '/nav', '/faq']) {
  const r = await fetch(base + p + '?v=' + t, { method: 'GET' });
  const cc = r.headers.get('cache-control') || '';
  const m = cc.match(/s-maxage=(\d+)/);
  htmlTtl.push(p + ':' + (m ? m[1] : 'none'));
  push('HTML 页边缘缓存 ≤ 15 分钟 ' + p, m && Number(m[1]) <= 900, cc);
}
const llms = await fetch(base + '/llms.txt?v=' + t);
const llmsText = await llms.text();
push('/llms.txt', llms.ok && llmsText.startsWith('# '), llms.status + ' ' + llmsText.length + 'B');
push('/llms.txt 提到 /api/rank', llmsText.includes('/api/rank?range='), '');

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
push('文章配图可放大（灯箱标记）', artText.includes('id="lightbox"') && artText.includes('class="lb-close"'), '');
push('灯箱有开关函数且 Esc 不冒泡', artText.includes('function openLb') && artText.includes('function closeLb'), '');
push('灯箱支持多图左右切换', artText.includes('id="lbPrev"') && artText.includes('id="lbCount"') && artText.includes('function lbStep'), '');
push('/articles 卡片布局', artPage.ok && artText.includes('acard'), artPage.status);
push('文章封面支持', artText.includes('acover') && artText.includes('a.cover'));

push('问答分类计数', faqText.includes('counts[t]') && faqText.includes("chip b"));
push('问答折叠标记', faqText.includes('summary:after') && faqText.includes('content:"+"'));
push('导航加载骨架', home.includes('class="navskel"') && home.includes('aria-busy="true"'), '');
push('导航空态卡与重置', home.includes('class="navempty"') && home.includes('data-navreset'), '');
push('问答加载骨架', faqText.includes('function renderSkeleton') && faqText.includes('skrow'), '');
push('问答空态卡与重置', faqText.includes('没有匹配的问题') && faqText.includes('data-reset'), '');
push('文章封面预留比例（不跳动）', artText.includes('aspect-ratio:16/9'), '');
push('文章卡有键盘焦点环', artText.includes('.acard:focus-visible'), '');
push('窄屏表格最小列宽（不再挤成竖排）', artText.includes('min-width:88px'), '');
push('窄屏表格右缘滚动提示', artText.includes('box-shadow:inset -14px 0 12px -14px'), '');
push('文章页统计卡窄屏三列一行', artText.includes('repeat(3,minmax(0,1fr))'), '');
push('品牌副标题窄屏最多两行', home.includes('-webkit-line-clamp:2'), '');
push('后台命令面板有手机入口', adm.includes('id="cmdkFab"'), '');
push('后台窄屏表单字号 16px（iOS 不放大）', adm.includes('#app input:not([type=checkbox]):not([type=radio]),#app select,#app textarea{font-size:16px'), '');
push('后台问答答案框窄屏 16px', adm.includes('#app #qaList .qa-a{font-size:16px'), '');
push('后台平台表窄屏堆叠成卡片', adm.includes('.geo-plat thead{display:none'), '');
push('后台侧栏滚动渐隐（x-end + paintSide）', adm.includes('x-end') && adm.includes('__paintSide'), '');
push('前台手机端表单 16px（文章页）', artText.includes(':is(input,select,textarea):not([type=checkbox])'), '');
  // —— 阅读器状态与地址栏一致（v179）
  push('阅读器界面与历史分离（hideReader）', artText.includes('function hideReader'), '');
  push('打开文章时用 rAF 回到正文顶部', artText.includes('requestAnimationFrame(function () { window.scrollTo(0, 0); })'), '');
  push('关闭阅读器走 history.back()（后退语义正确）', artText.includes('history.back()') && artText.includes('readerPushed'), '');
  // —— 筛选空态说清是哪一步筛掉的（v180）
  push('筛选空态卡（empty-filter）', artText.includes('empty-filter') && artText.includes('ef-cond'), '');
  push('筛选空态列出条件与底数', artText.includes('当前筛选：') && artText.includes('站内一共 '), '');
  push('筛选空态三个出口按钮', artText.includes('data-ef="q"') && artText.includes('data-ef="cat"') && artText.includes('data-ef="all"'), '');
push('前台手机端表单 16px（问答页）', faqText.includes('#q,#search,#navSearch{font-size:16px'), '');
push('点 tab 后侧栏会把当前项滚进可视区', adm.includes('scrollIntoView({ block:'), '');
push('翻页落点是列表顶（goList 自己算偏移）', bundleJs.includes('function goList()') && bundleJs.includes('const OFFSET = 76'), '');
push('列表给了 scroll-margin-top（吸顶条让位）', home.includes('#list{list-style:none') && home.includes('scroll-margin-top:76px'), '');
push('翻页校正不会和读者抢滚动条（listAnchorGen 代际标记）', bundleJs.includes('listAnchorGen++'), '');
push('无障碍：首页给了 accent-ink / accent-text 两个颜色', home.includes('--accent-ink:#8a6008') && home.includes('--accent-text:#8a6008'), '');
push('无障碍：选中态胶囊用 accent-ink 托白字', home.includes('.chip.is-on{background:var(--accent-ink,var(--accent))'), '');
push('无障碍：文章页胶囊有 aria-pressed', artText.includes('aria-pressed="\' + (state.cat === \'all\')'), '');
push('无障碍：问答页表格 th 带 scope', faqText.includes('<th scope="col">'), '');
push('无障碍：三个搜索框都有 aria-label', home.includes('aria-label="搜索站点"') && artText.includes('aria-label="搜索文章"') && faqText.includes('aria-label="搜索问答"'), '');
push('阅读器标题窄屏 23px', artText.includes('.reader h1,.reader h2{font-size:23px'), '');
push('后台表格窄屏可横滚', adm.includes('#navAdmin{overflow-x:auto;'), '');
push('问答搜索有高亮（highlightNode + hitmark）', faqText.includes('function highlightNode') && faqText.includes("className = 'hitmark'"));
push('问答计数显示命中条数', faqText.includes('命中') && faqText.includes('当前显示'));
push('问答答案先转义再解析 markdown', faqText.includes('function inline(s) {') && faqText.includes('return esc(s)'));
push('问答标签计数跟随搜索', faqText.includes('renderTags(kw)'), '');
push('问答 0 命中标签被压暗并禁用', faqText.includes('is-empty') && faqText.includes('aria-disabled'), '');

const health = await fetch(base + '/api/health?v=' + t);
const healthJson = await health.json().catch(() => null);
const hv = healthJson && (healthJson.assetV || healthJson.version || (healthJson.status && healthJson.status.assetV));
push('/api/health', health.ok && !!hv, health.status + ' ' + (hv || ''));
push('/api/health 带数据新鲜度 dataAge', !!(healthJson && healthJson.dataAge && typeof healthJson.dataAge.minutes === 'number'), JSON.stringify(healthJson && healthJson.dataAge));
push('/api/health 内容量与后台一致（六字段）', !!(healthJson && healthJson.counts && typeof healthJson.counts.qa === 'number' && typeof healthJson.counts.navGroups === 'number' && typeof healthJson.counts.links === 'number'), JSON.stringify(healthJson && healthJson.counts));
push('后台体检卡有「数据新鲜度」一行', adm.includes('数据新鲜度'), '');

push('后台 SEO 结果预览', adm.includes('serpTitle') && adm.includes('serpDesc'));
push('后台广告预览按钮', adm.includes('data-adprev') && adm.includes('adPrevDlg'));
push('后台二维码预览', adm.includes('contactQrPrev') && adm.includes('contactQrImg'));

push('后台「还能补的设置」清单', adm.includes('todoBox') && adm.includes('loadTodo') && adm.includes('todoReload'));
push('清单可跳转到对应面板', adm.includes("go(tab)") || adm.includes('去设置'));

const rss = await fetch(base + '/rss.xml?v=' + t);
const rssText = await rss.text();
push('/rss.xml 订阅源', rss.ok && rssText.indexOf('<rss version="2.0"') > 0 && rssText.indexOf('<channel>') > 0, rss.status + ' ' + rssText.length + 'B');

const subApi = await fetch(base + '/api/submit?v=' + t);
const subJson = await subApi.json().catch(() => null);
const subStatus = (subJson && subJson.status) || {};
push('/api/submit 状态', subApi.ok && typeof subStatus.urlCount === 'number' && subStatus.urlCount > 0, 'urlCount=' + subStatus.urlCount);

push('密钥输入默认遮罩', adm.includes('data-eye') && adm.includes('type="password"'));

push('导航批量导入支持选文件', adm.includes('id="navImpFile"'));

push('批量改分类是下拉', adm.includes('<select id="artBulkCat"'));

push('前台搜索支持 / 快捷键', home.includes('按 / 快速定位'));

push('问答保存按钮有独立回执位', adm.includes('id="qaSaveMsg"'));
push('后台无重复 id', (adm.match(/id="qaMsg"/g) || []).length === 1);

push('文章面板有保存按钮', adm.includes('data-save="article"') && adm.includes('id="artSaveMsg"'));

push('后台控件都有可访问名称', adm.includes('aria-label="问题"') && adm.includes('aria-label="文章排序方式"') && adm.includes('aria-label="选中这篇文章"'));
push('弹窗标题从 h2 起（无跳级）', /<h2 id="artTitle"/.test(adm) && !/<h3 id="artTitle"/.test(adm));
push('文章页侧栏标题都是 h2（且不再有「关于本站」）', art.includes('<h2>分类</h2>') && art.includes('<h2>站内</h2>') && !art.includes('<h4>分类</h4>') && !art.includes('关于本站'));
push('文章页有打印样式', art.includes('@media print') && art.includes('.blistwrap.is-reading .cards'));
push('首页有打印样式', home.includes('@media print') && home.includes('break-inside:avoid'));
push('问答页打印前自动展开', faqText.includes("addEventListener('beforeprint'"));

// 单篇文章页的按篇 SEO（外壳仍是 /articles，但 head 要换成这一篇的）
{
  const aseoList = await (await fetch(base + '/api/articles?v=' + t)).json().catch(() => ({}));
  const aseoOne = ((aseoList.articles || []).filter((a) => a && a.slug && a.id)).pop();
  if (aseoOne) {
    const aseoPath = '/articles/' + String(aseoOne.slug).split('/').map(encodeURIComponent).join('/') + '.html';
    const aseoRes = await fetch(base + aseoPath + '?v=' + t);
    const aseoHtml = await aseoRes.text();
    push('文章规范地址 200', aseoRes.status === 200, String(aseoRes.status));
    push('标题按文章注入', aseoHtml.includes('<title>' + String(aseoOne.title || '').slice(0, 6)), (aseoHtml.match(/<title>[\s\S]*?<\/title>/i) || [''])[0]);
    push('canonical 指向本篇', aseoHtml.includes(aseoPath + '"'), '');
    push('注入 BlogPosting', aseoHtml.includes('"@type":"BlogPosting"'), '');
    push('og:type=article', aseoHtml.includes('property="og:type" content="article"'), '');
  }
  const aseoMiss = await fetch(base + '/articles/nosuch/999.html?v=' + t);
  push('不存在的文章 404', aseoMiss.status === 404, String(aseoMiss.status));
}

const pubRes = await fetch(base + '/data/articles.json?v=' + t);
const pubText = await pubRes.text();
let pubArr = null;
try { pubArr = JSON.parse(pubText); } catch (e) {}
push('文章列表不外发密文', pubRes.status === 200 && !/"lock"\s*:/.test(pubText), 'status=' + pubRes.status);
push('文章列表带 hasLock', Array.isArray(pubArr) && pubArr.every((x) => typeof x.hasLock === 'boolean'), Array.isArray(pubArr) ? pubArr.length + ' 条' : 'not array');
push('首页文章卡片有阅读时长', home.includes('artcard-min') && home.includes('readMins'));

const artListRes = await fetch(base + '/articles?v=' + t);
const artListHtml = await artListRes.text();
push('文章列表页有「相关阅读」', artListHtml.includes('relatedHtml') && artListHtml.includes('.related .rmeta-in'), 'status=' + artListRes.status);
push('阅读器上/下一篇带方向标记', artListHtml.includes('data-dir="newer"') && artListHtml.includes('data-dir="older"'), '');
push('阅读器首尾有边界提示', artListHtml.includes('已经是第一篇') && artListHtml.includes('已经是最后一篇') && artListHtml.includes('function flashLim'), '');
push('阅读器换篇按 slug 解析（findArt）', artListHtml.includes('var hit = findArt(id);'), '');
push('文章页侧栏「最新文章」用规范地址 + data-id', artListHtml.includes('esc(artPath(a))') && artListHtml.includes('data-id='), '');
push('文章页侧栏保留旧 #id 链接的兼容分支', artListHtml.includes('href.charAt(0)'), '');
push('文章页筛选状态写进 URL', artListHtml.includes('function syncUrl(push)') && artListHtml.includes('readUrlFilters()'), '');
push('问答页筛选状态写进 URL', faqText.includes('function syncUrl(push)') && faqText.includes('readUrlFilters()'), '');
push('文章列表页有分页条', artListHtml.includes('id="apager"') && artListHtml.includes('var PER = 9;'), '');
push('文章搜索有命中片段与高亮', artListHtml.includes('function excerptOf') && artListHtml.includes('mark class="hitmark"') && artListHtml.includes('class="hitsrc"'), '');
push('文章正文参与搜索匹配', artListHtml.includes('plainOf(a.body)'), '');
push('首页文章卡片有置顶徽标代码', home.includes('pinchip'), '');
push('首页最新文章最多 6 篇', home.includes('var HOME_MAX=6;'), '');
push('导航分组可折叠并记住状态', home.includes('class="gtog"') && home.includes('ghrank-nav-closed'), '');
push('导航「显示全部」状态跨刷新保留', home.includes('ghrank-nav-open'), '');
push('首页尊重「减少动效」偏好', home.includes('prefers-reduced-motion: reduce'), '');
push('榜单分页器有「跳到第 N 页」', home.includes('id="pgJump"') && home.includes('class="pjump"'), '');
push('跳页逻辑已绑定（bundle）', bundleJs.includes('goJump'), '');
push('分页器有 −/＋ 步进按钮', home.includes('id="pgDec"') && home.includes('id="pgInc"') && home.includes('class="pjbtn"'), '');
push('步进器支持长按连点（bundle）', bundleJs.includes("bindHold('pgInc'") && bundleJs.includes('setInterval'), '');
push('榜单卡片键盘聚焦有高亮', home.includes(".item:focus-within"), '');
push('/articles 有返回顶部按钮', artListHtml.includes('id="totop"') && artListHtml.includes('initTotop'), '');
push('/articles 页脚有 RSS 订阅', artListHtml.includes('href="/rss.xml"'), '');
push('/articles 阅读器有进度条', artListHtml.includes('id="rprogress"') && artListHtml.includes('function paintProgress'), '');
const faqTotop = await (await fetch(base + '/faq?v=' + t)).text();
push('/faq 有返回顶部按钮', faqTotop.includes('id="totop"') && faqTotop.includes('initTotop'), '');
push('/faq 页脚有 RSS', faqTotop.includes('href="/rss.xml"'), '');
const admHtml = await (await fetch(base + '/admin?v=' + t)).text();
push('主题面板有「你现在会看到什么」的状态行', admHtml.indexOf('id="themeState"') >= 0, '');
push('问答「删除」按钮只走一条路径（先确认再删，不再双重处理）', admHtml.indexOf('点「保存问答」才生效') >= 0 && admHtml.indexOf("closest('[data-qadel]')") >= 0 && admHtml.indexOf('已删除 1 条，点「保存问答」后才会真正生效') < 0, '');
push('地址预览会先校验序号（不再承诺存不下来的地址）', admHtml.indexOf('序号只能是数字') >= 0 && admHtml.indexOf('序号要从 1 开始') >= 0, '');
push('主题状态说明本地选择会盖过站点默认', admHtml.indexOf('保存过访客主题') >= 0, '');
push('主题面板给「清除本地主题」入口', admHtml.indexOf('themeClearLocal') >= 0, '');
push('备案面板有「现在页脚显示什么」的状态行', admHtml.indexOf('id="beianState"') >= 0, '');
push('备案状态提示：填了号码也要勾开关', admHtml.indexOf('填了号码也要勾上这个开关') >= 0, '');
push('备案状态会说出最终显示什么', admHtml.indexOf('function beianAudit') >= 0 && admHtml.indexOf('页脚会显示：') >= 0, '');
const artJsonTxt = await (await fetch(base + '/data/articles.json?cb=' + t)).text();
push('公开文章数据不暴露 prevSlugs（只给 prevCount）', artJsonTxt.indexOf('prevSlugs') < 0 && artJsonTxt.indexOf('prevCount') >= 0, '');
push('后台文章分页会回到表格顶（artGoPage + artPgY）', admHtml.includes('function artGoPage(n)') && admHtml.includes('var artPgY = {}'), '');
push('后台文章分页有「跳到第 N 页」', admHtml.includes('id="artJump"') && admHtml.includes("data-artjump"), '');
push('窄屏分页按钮不折行（nowrap + min-width 84）', admHtml.includes('#pane-articles .artpager button{white-space:nowrap;min-width:84px'), '');
push('滚动条分区写清出现范围（首页与导航页）', admHtml.includes('首页与导航页的顶部') && admHtml.includes('文章页、问答页是独立页面'), '');
push('滚动条有就地提醒位与校验函数', admHtml.includes('id="tickerWarn"') && admHtml.includes('function tickerAudit()'), '');
push('提醒与输入框/开关联动（change + input）', admHtml.includes('ticker-enabled").onchange = tickerAudit') && admHtml.includes('ticker-text").oninput = tickerAudit'), '');
push('后台也有 reduced-motion 兜底', admHtml.includes('@media (prefers-reduced-motion: reduce)'));
push('后台控件都有可访问名（广告槽位）', admHtml.includes('：广告 HTML 片段') && admHtml.includes('：点击跳转链接'));
push('后台筛选框有可访问名', admHtml.includes('筛选问答（问题、答案、标签）') && admHtml.includes('筛选常用站点'));
push('后台摘要/提示框有可访问名', admHtml.includes('站点简介（给 AI 搜索看的一段话）') && admHtml.includes('解锁提示文案'));
// —— 后台文章列表手机端变卡片（v181）
push('文章表格手机端变卡片（tr grid）', admHtml.includes('#artTbody tr{display:grid'), '');
push('卡片摘要最多两行', admHtml.includes('-webkit-line-clamp:2;-webkit-box-orient:vertical'), '');
push('操作按钮等宽铺满一行', admHtml.includes('#artTbody td:nth-child(5) button{flex:1 1 0'), '');
push('后台导航空态带清空筛选', admHtml.includes('data-navfreset'), '');
push('后台导航分类空态按钮', admHtml.includes('data-empty-act="nav-cat-add"'), '');
push('后台空态卡样式', admHtml.includes('.empty-card{padding:30px'), '');
push('后台文章空态带重置按钮', admHtml.includes('data-empty-act="artreset"'), '');
push('后台空态按钮委托表', admHtml.includes('EMPTY_ACT'), '');
push('写文章弹窗有链接实时预览', admHtml.includes('artSlugPrev') && admHtml.includes('function slugPreview'), '');
push('后台友链有上移/下移按钮', admHtml.includes('data-up=') && admHtml.includes('data-down='), 'bytes=' + admHtml.length);
push('后台问答行有上移/下移按钮', admHtml.includes('data-qaup=') && admHtml.includes('data-qadn='), '');
push('后台导航页有分类/站点上下移动', admHtml.includes('data-gup=') && admHtml.includes('data-sup='), '');
push('首页导航分组有「加载更多」', home.includes('navmore') && home.includes('var NAV_PAGE=12'), '');
push('导航页加载更多按钮有胶囊样式', home.includes('.navmore{') && home.includes('显示全部 '), '');
push('文章目录宽屏默认展开（窄屏收起）', artListHtml.includes('toc.dataset.touched') && artListHtml.includes('window.innerWidth >= 900'), '');
push('文章目录窄屏有专用排版', artListHtml.includes('@media (max-width:640px)'), '');
push('文章页打印前会展开目录', artListHtml.includes('beforeprint') && artListHtml.includes('__wasOpen'), '');
push('后台文章面板有分类筛选', admHtml.includes('id="artCatFilter"') && admHtml.includes('fillCatFilter'), '');
push('后台分类筛选有「全部分类」选项', admHtml.includes('全部分类'), '');
push('后台问答面板有按标签筛选', admHtml.includes('id="qaTagFilter"') && admHtml.includes('fillQaTags'), '');
push('后台问答筛选能真过滤', admHtml.includes('没有匹配的问答'), '');
push('导航页有「还没有站点」空态', home.includes('class="navempty"') && home.includes('还没有站点'), '');
push('导航页搜索有高亮（navHl + hitmark）', home.includes('function navHl') && home.includes('class="hitmark"'), '');
push('导航分组名也参与搜索匹配', home.includes('var gHit=!!q'), '');

const healthApi = await (function () {
  return fetch(base + '/api/health?v=' + t, { headers: { 'cache-control': 'no-cache' } }).then(function (r) { return r.json(); });
})().catch(function () { return null; });
push('体检接口一次返回提交状态（health.submit）', !!(healthApi && healthApi.submit && typeof healthApi.submit.keyFileOk === 'boolean'), '');
push('体检接口带 AI 与保活摘要', !!(healthApi && healthApi.translator && typeof healthApi.level === 'string' && healthApi.next !== undefined), '');
push('后台体检只发一个请求（todoCounts）', admHtml.includes('todoCounts') && admHtml.indexOf("api('/api/health')") >= 0, '');
push('文章分页器窄屏信息独占一行', artListHtml.includes('.apager span{order:-1'), '');
push('后台保存按钮手机吸底并给 ⌘ 留位', admHtml.includes('.card .actions{position:sticky') && admHtml.includes('padding:10px 0 12px 70px'), '');
push('导航页空态小屏按钮加高（44px 触控）', home.includes('.navempty .btn,.navempty button,.navempty a.btn{min-height:44px'), '');
push('命令面板条目小屏 44px + 触屏措辞', admHtml.includes('#cmdk .ck-item{min-height:44px') && admHtml.includes('id="ckFoot"'), '');
push('文章页分类胶囊小屏单行横滚', artText.includes('.chips{flex-wrap:nowrap') && artText.includes('function paintChips'), '');
push('后台文章工具栏小屏先筛后排', admHtml.includes('#pane-articles .toolbar>#artSort{order:1'), '');
push('后台侧栏小屏隐藏分组小标题', admHtml.includes('.side .navgroup{display:none}'), '');
push('后台侧栏小屏压成一行（max-height 58）', admHtml.includes('.side{max-height:58px'), '');
push('问答页标签条小屏单行横滚', faqText.includes('.chips{flex-wrap:nowrap') && faqText.includes('function paintChips'), '');
push('首页「文章」是页内 tab（button + artView）', home.includes('id="tabArticles"') && home.includes('data-view="articles"') && home.includes('id="artView"'), '');
push('文章视图带搜索与分类胶囊', home.includes('id="artSearch"') && home.includes('id="artChips"') && home.includes('function renderArtView'), '');
push('非榜单视图时收起榜单工具栏与统计卡', home.includes('body[data-page="articles"] #rankBar'), '');
push('文章页去掉统计卡与「关于本站」', !artText.includes('id="stCount"') && !artText.includes('id="aboutText"') && artText.includes('站长写的一些记录，按时间倒序'), '');
push('bundle 同步地址时保留 page=articles', bundleJs.includes("pageMark === 'nav' || pageMark === 'articles'"), '');
push('首页「问答」也是页内 tab（button + faqView）', home.includes('id="tabFaq"') && home.includes('data-view="faq"') && home.includes('id="faqView"'), '');
push('问答视图带搜索与标签条', home.includes('id="faqSearch"') && home.includes('id="faqChips"') && home.includes('function renderFaq'), '');
push('问答视图也收起榜单工具栏', home.includes('body[data-page="faq"] #rankBar'), '');
push('bundle 同步地址时保留 page=faq', bundleJs.includes("pageMark === 'faq'"), '');
push('文案不再宣传加密文章', !home.includes('加密文章需要密码') && !artText.includes('加密文章需要输入密码') && !faqText.includes('加密文章怎么解锁'), '');
push('/faq 顶栏指向站内视图', faqText.includes('href="/?page=faq"') && faqText.includes('href="/?page=articles"'), '');
push('榜单卡标签折叠有 +N 样式', home.includes('.tag.more{background:transparent'), '');
push('榜单卡复制/卡片按钮 hover 才出现', home.includes('#list .item .mini{opacity:0') && home.includes('@media (hover:none)'), '');
push('榜单卡文案：活跃度 + 短更新时间', bundleJs.includes("'活跃度 '") && bundleJs.includes("'更新'") , '');
push('榜单卡取自然高度（不再强行等高留白）', home.includes('gap:var(--gap);align-items:start}') , '');
push('分类胶囊有统一视觉（实心选中 + 圆角 + hover）', home.includes('.chip.is-on{background:var(--accent-ink') && home.includes('.chip:hover{border-color:var(--accent)') && home.includes('function paintChipBox'), '');
push('文章页胶囊与首页同一套样式', artText.includes('.chip.is-on{background:var(--accent-ink') && artText.includes('.chip:hover{border-color:var(--accent)'), '');
push('问答页胶囊选中改为实心（与首页一致）', faqText.includes('.chip.is-on{background:var(--accent-ink') && faqText.includes('.chip:hover{border-color:var(--accent)'), '');
push('空的数据来源提示不占位', home.includes('#srcNote:empty{display:none}'), '');
push('数据来源提示改成人话（静态数据不再解释一堆）', bundleJs.includes('本次数据：刚从 GitHub 实时拉取') && !bundleJs.includes('当前数据：定时抓取的静态文件'), '');
push('窄屏有「分析」按钮收起侧栏', home.includes('id="insightBtn"') && home.includes('.insights-toggle{display:none'), '');
push('窄屏侧栏挪到榜单上方（order:-1）', home.includes('.insights{order:-1'), '');
push('收起/展开逻辑在 bundle 里', bundleJs.includes('syncInsightFold'), '');
push('底部说明一句话 + 「数据怎么来的」按钮', home.includes('id="aboutMore"') && home.includes('class="linkbtn"'), '');
push('技术细节在关于弹窗里折叠', home.includes('<details class="technote">') && home.includes('数据是怎么取的（技术细节）'), '');
push('卡片信息行按需显示 Fork', bundleJs.includes('按 Fork 排序」时才显示') && bundleJs.includes("state.sort === 'forks'"), '');
push('窄屏隐藏站长按钮并收窄信息行行距', home.includes('#list .item .mini{display:none}') && home.includes('#list .item .meta{gap:2px 10px}'), '');
push('分类名改成大白话', bundleJs.includes("label: 'AI 与大模型'") && bundleJs.includes("label: '数据与后端'") && !bundleJs.includes("label: 'AI / LLM'"), '');
push('分类胶囊有 aria-pressed 与「只看…」提示', bundleJs.includes("setAttribute('aria-pressed'") && bundleJs.includes('相关的项目（再点一次取消）'), '');
push('设置面板三块独立卡片 + Token 卡存在', home.includes('id="tokenCard"') && home.includes('#settings>.card{'), '');
push('Token 提示改成短句（两处占位符都换了）', bundleJs.includes('粘贴以 ghp_ 开头的 Token（可不填）'), '');
push('教程默认收起（不再一屏六步）', home.includes('<summary>怎么获取 Token（约 1 分钟）</summary>') && !home.includes('<details class="guide" open>'), '');
push('导出类按钮移进「设置 → 数据」', home.includes('<b>数据</b>') && home.includes('收藏只存在这个浏览器'), '');
push('统计区压成一行摘要（不再是四张卡）', home.includes('.stats.slim{display:flex') && home.includes('.stat-lang{') , '');
push('摘要里的「最热语言」可点击筛选', bundleJs.includes("'stat-lang'") && bundleJs.includes("new Option(topLang[0], topLang[0])"), '');
push('窄屏有「筛选」按钮与角标', home.includes('id="mfToggle"') && home.includes('id="mfBody"') && home.includes('id="mfN"'), '');
push('桌面用 display:contents 保持三个下拉行内', home.includes('#rankBar .mf-body{display:contents}'), '');
push('榜单分类胶囊窄屏单行横滚 + 渐隐', home.includes('#cats{flex-wrap:nowrap;overflow-x:auto') && home.includes('#cats.x-end{-webkit-mask-image:none'), '');

push('数据没读到时给错误卡片（而不是空白）', bundleJs.includes('function errReason') && bundleJs.includes("'err-card'") && home.includes('.errbox{'), '');
push('翻页位置记忆（离开一页记位置、回访恢复）', bundleJs.includes('function pgKey()') && bundleJs.includes('window.__pgY = pgY'), '');
push('上一页/下一页走 setPage（不再一律回列表顶）', bundleJs.includes("$('prev').onclick = () => setPage(state.page - 1)") && bundleJs.includes("$('next').onclick = () => setPage(state.page + 1)"), '');
push('换排序 / 换每页条数后回到列表起点', bundleJs.includes("syncHash(); render(); goList(); };") && bundleJs.includes('state.pageSize = +e.target.value'), '');
push('错误卡给「重试 / 稍后再看」并安抚本地数据', bundleJs.includes("el('button', 'btn', '重试')") && bundleJs.includes("el('button', 'btn ghost', '稍后再看')") && bundleJs.includes('收藏和主题设置存在你自己的浏览器里'), '');
push('静态数据没读到会立刻改说实时拉取', bundleJs.includes('静态数据没读到，正在从 GitHub 实时拉取') && bundleJs.includes('还在拉取…GitHub 响应有点慢'), '');
push('后台保存有常驻状态行（不再是 toast）', admHtml.includes('.save-msg.err{color:var(--bad)}') && admHtml.includes('function saveRun') && admHtml.includes("setAttribute('role', 'status')"), '');
push('后台封面字段接受站内路径（文本框 + hint）', admHtml.includes('id="artCover"') && admHtml.includes('站内以 / 开头的路径'), '');
push('后台封面有预览（尺寸 + 打不开提示）', admHtml.includes('id="covPrevWrap"') && admHtml.includes('function artCoverPaint') && admHtml.includes('这张图打不开'), '');
push('封面校验口径与前台一致（允许 / 开头）', admHtml.includes('v.charAt(0) === ') || admHtml.includes('要填 http(s):// 链接，或站内以 / 开头的路径'), '');
push('后台文章列表可行内改分类（下拉 + 状态行）', admHtml.includes('data-artcat=') && admHtml.includes('id="artInlineMsg"') && admHtml.includes('function setArtCat'), '');
push('静态文章页的 md.js 用绝对路径（嵌套 URL 不 404）', (await (await fetch(base + '/articles/cat/1.html?t=' + t)).text()).includes('src="/js/md.js'), '');
push('后台对话框统一 aria-modal（showModal 包裹）', admHtml.includes('HTMLDialogElement.prototype.showModal') && admHtml.includes('setAttribute("aria-modal", "true")'), '');
push('后台对话框 Tab 首尾环（栈式，只对最上层生效）', admHtml.includes('DLG_STACK') && admHtml.includes('var first = list[0], last = list[list.length - 1]'), '');
push('后台 Esc 只点取消/关闭，不误触删除', admHtml.includes('function dlgCancelText') && admHtml.includes('pick.click()'), '');
push('导航每行有「打开」链接（新标签 + noopener）', admHtml.includes('class="small nav-open"') && admHtml.includes('target="_blank" rel="noopener"'), '');
push('「打开」有带站点名的可访问名', admHtml.includes('aria-label="打开 \' + navEsc(it.name'), '');
push('后台站点地址按当前域名注入（__SITE__ 已替换）', admHtml.includes('value="https://github.661026.xyz/sitemap.xml"') && !admHtml.includes('__SITE__') && !admHtml.includes('__HOST__'), '');
push('收录面板状态分三组（凭据/站点/记录）', admHtml.includes('class="sgroup"') && admHtml.includes('sgh">凭据') && admHtml.includes('sgh">记录'), '');
push('提交结果有「接下来」出口（Bing / 百度 / 平台清单）', admHtml.includes('function subNext') && admHtml.includes('bing.com/webmasters/sitemaps') && admHtml.includes('#geoCard'), '');
push('没填网址时「打开」不可点（span 而非 href=#）', admHtml.includes('nav-open off') && admHtml.includes('还没填网址'), '');
push('保存按钮文字会变「保存中…」并恢复', admHtml.includes("saveLabel(btn, '保存中…')") && admHtml.includes('btn.textContent = text || btn.dataset.label'), '');
push('保存失败给人话原因 + 重试', admHtml.includes("msg.textContent = '保存失败：' + saveReason(r)") && admHtml.includes("again.textContent = '重试'"), '');
push('删除结果有常驻状态行助手', admHtml.includes('function paintDelMsg') && admHtml.includes('function delMsgBox'));
push('删除确认框讲清后果与能否撤销', admHtml.includes('删完可以点「撤销」恢复') && admHtml.includes('删除不可撤销'));
push('删问答会提示要先保存才生效', admHtml.includes('已从列表移除 1 条 · 点「保存问答」才生效'));
push('文章编辑器有本地草稿与「恢复草稿」', admHtml.includes("var ART_DRAFT = 'ghrank-art-draft'") && admHtml.includes('function artOfferDraft') && admHtml.includes('id="draftRestore"'));
push('未保存时关弹窗会先确认', admHtml.includes('这篇还没保存') && admHtml.includes("'放弃改动'"));
push('刷新/关标签页有拦截', admHtml.includes("addEventListener('beforeunload'") && admHtml.includes('artDirty'));
push('首页文章卡片有阅读时长', home.includes('function artMins(') && home.includes("'约 '+mins+' 分钟'"));
push('首页文章卡片分类尊重「显示英文」开关', home.includes('function artCardCat(') && home.includes('siteCatEn'));
push('静态文章页不再出现「旧数据未加密」', !artListHtml.includes('旧数据未加密'));
push('静态文章页无分类时不拿 slug 冒充分类', artListHtml.includes('别拿 slug 前缀冒充分类'));
push('阅读器有字号调节（A−/A＋）', artListHtml.includes('id="rfMinus"') && artListHtml.includes('id="rfPlus"') && artListHtml.includes('RF_STEPS'));
push('字号记在本机 localStorage', artListHtml.includes('ghrank-reader-font'));
push('阅读器不再出现「加密文章」措辞', !artListHtml.includes('加密文章'));
push('不再给读者看「以前标记过加密（旧数据）」', !artListHtml.includes('以前标记过加密'));
const bundleSrc = await (await fetch(base + '/js/bundle.js?v=' + t)).text();
push('输入法打字时不逐字过滤（首页）', bundleSrc.includes('function imeBind'));
push('静态文章页也跳过拼音阶段', artListHtml.includes('compositionstart'));
push('后台三个筛选框也跳过拼音阶段', admHtml.includes('function imeBind') && admHtml.includes("imeBind($('navFilter')"));

push('文章卡片列数可设置（首页）', home.includes('html[data-artcols="triple"] .artgrid') && home.includes('applyArtCols'));
push('文章页跟随列数设置', artListHtml.includes('html[data-artcols="double"] .cards'));
push('后台有列数开关', admHtml.includes('type="radio" name="article-cols"') && admHtml.includes('文章卡片列数'));

push('文章详情是页内阅读器（不再跳 /articles/xxx.html）', home.includes('id="artDlg"') && home.includes('class="artdlg"') && home.includes('data-artpost'));
push('文章详情地址用 ?post= 深链（bundle 也保留它）', home.includes('/?page=articles&post=') && bundleJs.includes("get('post')"));
push('阅读器 Esc 可关（document 捕获层）', home.includes("!dlg.open) return;"));
push('手机一列时布局改成 stretch（不再横向溢出/右侧空条）', home.includes('.layout{display:flex;flex-direction:column;align-items:stretch}'));
push('分页器窄屏改两行网格', home.includes('#pager{display:grid;grid-template-columns:auto minmax(0,1fr) auto') && home.includes('#pager #pageInfo{grid-area:1 / 2'));
push('步进按钮撑到 34×34', home.includes('.pjbtn{min-width:34px;min-height:34px}'));
push('可点目标最小 32px（阅读全文/全部文章/ticker ×）', home.includes('.ad-ticker .tk-x{width:34px;height:34px') && home.includes('.artmore,#artViewList .artcard a.read'));
push('「分析」按钮只属于榜单视图', home.includes('body[data-page="nav"] #insightBtn'));
push('导航卡片网址行 12px（小屏）', home.includes('.navcard .host{font-size:12px}'));
push('分类计数与网址行小屏提到 12px', home.includes('.navgroup>h3 .cnt,.nj em,.navcard .host{font-size:12px}'));
push('问答分类胶囊 12px（两处）', home.includes('.faqview .qa .qtag{flex:0 0 auto;font-size:12px') && faqText.includes('.qtag{font-size:12px'));
push('问答序号可点面积 ≥32 高', faqText.includes('min-width:34px;min-height:32px'));
push('正文链接可点面积加厚（inline-block 负边距）', home.includes('.faqview .artvlead a,.faqview .ans a{display:inline-block'));
push('问答导语不再宣传「加密文章」', !/加密文章怎么解锁/.test(faqText) && !/加密文章怎么解锁/.test(home));
push('搜索占位符按屏宽切换（短/长两套）', home.includes('data-ph-sm="搜项目、语言、标签…"') && home.includes('data-ph-lg='));
push('三页主题按钮文案统一「主题 · X」', /主题 · /.test(home) && /主题 · /.test(artText) && /主题 · /.test(faqText));
push('问答页补上主题按钮', faqText.indexOf('id="btnTheme"') >= 0);
push('静态文章页去掉重复副标题', artText.indexOf('站长写的东西，按时间倒序') < 0);
push('后台 320 窄屏：工具栏换行 + 长链接断行 + 卡片字号', /#pane-articles #artTbody td\{font-size:12\.5px\}/.test(admHtml) && admHtml.indexOf('word-break:break-all;overflow-wrap:anywhere') >= 0);
push('导航面板工具栏可换行', admHtml.indexOf('.nav-toolbar{flex-wrap:wrap') >= 0);
push('提交页平台表取消 min-width', admHtml.indexOf('.card:has(.geo-plat) table{min-width:0}') >= 0);
const weekJs = await (await fetch(base + '/data/repos-week.js?t=' + t)).text();
push('数据瘦身：不再落盘 url 字段', weekJs.indexOf('"url":"https://github.com/') < 0 && weekJs.length > 10000);
push('数据瘦身：时间戳是 epoch 秒', /(?:"updated"|updated)\s*:\s*1[6-9][0-9]{8}/.test(weekJs));
push('首页预载周榜数据（与 script 地址一致）', bundleJs.indexOf('s.src = file;') >= 0 && bundleJs.indexOf('function repoUrl(r)') >= 0);
const navHtml = await (await fetch(base + '/nav?t=' + t)).text();
const artHtml = await (await fetch(base + '/articles?t=' + t)).text();
push('文章页已清理 .bstats 死样式', !artHtml.includes('.bstats{'), '');
push('灯箱 Esc 守卫用 dialog 的 open（不是 div 时代的 hidden）', artHtml.includes('if (!lb.open) return;') && !artHtml.includes('if (lb.hidden) return;'), '');
push('阅读器进度条：短文隐藏、长文按页面滚动算百分比', artHtml.includes('maxY < window.innerHeight * 0.5') && artHtml.includes('Math.min(top - 100, maxY - 40)'), '');
push('静态文章页密码框有可访问名', artHtml.includes('aria-label="文章访问密码"'), '');
push('两页「自动」列宽统一为 320px', home.indexOf('minmax(320px,1fr))}') > 0 && artHtml.indexOf('minmax(320px,1fr)') > 0 && artHtml.indexOf('minmax(340px') < 0, '');
push('首页列数属性挂到 html（不再只挂 body）', home.indexOf('html[data-artcols="auto"] .artgrid') > 0 && home.indexOf('body[data-artcols') < 0, '');
push('后台说明讲清「自动」由宽度决定', admHtml.indexOf('列数由页面宽度决定') > 0 && admHtml.indexOf('可能不同') > 0, '');
  const artBodyRaw = await (await fetch(base + '/data/articles.json')).text();
  push('文章数据里没有重复的「…1111」测试文章', !artBodyRaw.includes('说明1111'), artBodyRaw.slice(0, 60));
  push('静态文章页对空正文给提示（不空白）', artHtml.includes('这篇还没有正文 —— 作者可能只存了标题和摘要。'), '');
  push('首页弹窗对空正文也给提示', home.includes('adl-empty'), '');
push('文章列表翻页记忆位置（apY + 只往回恢复）', artHtml.includes('window.__apY = apY') && artHtml.includes('function apRestore(y)'), '');
push('文章分页键含筛选维度', artHtml.includes("function apKey(n) { return [state.cat, state.q.trim(), state.sort, n].join('|'); }"), '');
push('往前翻仍回列表顶（scroll-margin 96）', artHtml.includes("box.scrollIntoView({ behavior: window.__sb(), block: 'start' })") && artHtml.includes('scroll-margin-top:96px'), '');
push('后台模态打开时锁背景（html/body overflow 置 hidden 并恢复）', admHtml.includes('document.documentElement.style.overflow = "hidden"') && admHtml.includes('__scH'), '');
push('前台图片查看器是原生 dialog', artHtml.includes('<dialog class="lightbox"') && artHtml.includes('.lightbox:not([open])'), '');
push('图片查看器用 showModal 打开并在关闭时解锁背景', artHtml.includes('if (!lb.open) lb.showModal()') && artHtml.includes('lb.__lbAuto'), '');
const faqHtml = await (await fetch(base + '/faq?t=' + t)).text();
push('静态页对话框焦点圈', artHtml.includes('__a11yTrap') && artHtml.includes("['pwDlg','adModal']"));
push('文章放大图默认隐藏且惰性加载', artHtml.includes('id="lbImg"') && artHtml.includes('loading="lazy"') && artHtml.includes('hidden'));
push('前端脚本引用带版本号（/articles 的 md.js）', /js\/md\.js\?v=/.test(artHtml));
push('不再有写死的 ?v=9', !artHtml.includes('?v=9'));
push('文章封面是真 <img>（可惰性加载、有尺寸）', artHtml.includes('<img class="acover"') && artHtml.includes('width="640" height="360" loading="lazy"'));
push('首页文章卡封面走 coverImg 工厂', home.includes('coverImg(it.cover)'));
push('导航分组折叠按钮在窄屏 ≥40px', home.includes('.navgroup .gtog{min-height:40px'), '');
push('站点胶囊在窄屏 ≥36px', home.includes('.nj{min-height:36px'), '');
push('状态行能挂「下一步」按钮', bundleJs.includes('action.target') && bundleJs.includes("'去设置'"), '');
push('状态行按钮有样式（不是黑药丸）', home.includes('#status .status-act{'), '');
push('文章页读失败给人话 + 重试', artHtml.includes('文章没读出来') && artHtml.includes('data-retry="1"') && artHtml.includes('不影响榜单'), '');
push('问答页读失败给人话 + 就地重试', faqHtml.includes('问答没读出来') && faqHtml.includes('data-qa-retry') && faqHtml.includes('loadQa()'), '');
push('文章页加载态是骨架卡（不是一句话）', artHtml.includes('sk-card') && artHtml.indexOf('正在加载文章') < 0, '');
push('三个前台页都有跳转链接（键盘直达正文）', home.includes('class="skip" href="#list"') && artHtml.includes('class="skip" href="#cards"') && faqHtml.includes('class="skip" href="#list"'), '');
push('跳转链接默认藏起来、聚焦才出现', home.includes('.skip:focus{left:0'), '');
push('/articles 不再把页面内锚点当文章 id', artHtml.includes('页面内锚点'), '');
push('卡片迷你按钮有可访问名', bundleJs.includes("'复制仓库链接'") && bundleJs.includes("'生成分享卡片'"), '');
push('导航页有自己的标题与 canonical（不是首页副本）', navHtml.indexOf('站点导航 · ') >= 0 && navHtml.indexOf('rel="canonical" href="' + base + '/nav"') >= 0);
push('导航页搜索空态有「清空搜索」出口', navHtml.indexOf('清空搜索看全部') >= 0 && navHtml.indexOf('data-navreset') >= 0, '');
push('文章页有完整分享卡', artHtml.indexOf('property="og:url" content="' + base + '/articles"') >= 0 && artHtml.indexOf('name="twitter:card"') >= 0);
push('问答页有完整分享卡', faqHtml.indexOf('property="og:url" content="' + base + '/faq"') >= 0 && faqHtml.indexOf('name="twitter:card"') >= 0);
push('问答页跟随站点主题（5 套 token 齐备）', ['dark', 'ink', 'stripe', 'notion'].every((t) => faqHtml.includes('html[data-theme="' + t + '"]')) && faqHtml.includes('--fg:var(--text)'), '');
push('问答页主题 token 与首页同值', ['--bg:#faf7f0', '--card:#ffffff', '--text:#1c2230'].every((k) => faqHtml.replace(/\s+/g, '').includes(k)), '');
push('问答页不再自带旧 palette（#fffdf8 / #7a6b56）', !faqHtml.includes('#fffdf8') && !faqHtml.includes('#7a6b56'), '');
push('实时刷新有「已用时」与进度文案', bundleJs.includes('正在实时刷新 · 已用 ') && bundleJs.includes("已取到 ' + got + ' 个项目"), '');
push('实时刷新能取消（真 abort，不是假文案）', bundleJs.includes('取消这次刷新') && bundleJs.includes('ctrl.abort()') && bundleJs.includes('已取消这次刷新，仍在看之前的数据'), '');
push('loadRepos 支持外部 signal', bundleJs.includes('outerSignal') && bundleJs.includes('if (signal && signal.aborted)'), '');
push('切榜单数据文件失败会出错误卡（不是一直转骨架）', bundleJs.includes('RANGE_TIMEOUT') && bundleJs.includes('rangeUsedFallback') && bundleJs.includes('数据文件加载超时'), '');
push('错误卡说清是哪份数据、给退路', bundleJs.includes('这个榜单的数据文件没读出来') && bundleJs.includes('或者先切回「近 7 天」'), '');
push('用备用数据文件时要说明可能不是最新', bundleJs.includes('这个榜单用的是备用数据文件（repos-all.js），可能不是最新的。'), '');
push('文章弹窗有目录 / 字号 / 复制链接三件套', home.includes('id="adlTocBtn"') && home.includes('id="adlPlus"') && home.includes('id="adlCopy"'), '');
push('两个阅读器共用字号存档与 --rfont', home.includes("RF_KEY='ghrank-reader-font'") && home.includes('var(--rfont'), '');
push('文章弹窗有上一篇/下一篇', home.includes('id="adlNav"') && home.includes('上一篇：'), '');
const siteJson = await (await fetch(base + '/api/site?cb=' + Date.now())).json();
const adKeys = Object.keys((siteJson && siteJson.site && siteJson.site.ad) || {}).sort().join(',');
push('ad 只剩白名单键（enabled,html,slots,ticker）', adKeys === 'enabled,html,slots,ticker', adKeys);
const cats = (siteJson && siteJson.site && siteJson.site.article && siteJson.site.article.categories) || [];
push('文章分类非空（空分类会让详情页 301）', Array.isArray(cats) && cats.length >= 1, 'categories=' + cats.length);

push('关闭阅读器不再用 history.back（会把人带离站点）', home.includes('深链进来时历史里没有 art 状态') && !home.includes('history.state.art) history.back()'), '');
push('底部边界提示可见时长 1.2 秒（原 0.7 秒太短）', artHtml.includes('classList.remove(\'is-hit\'); }, 1200)'), '');

const filtHtml = await (await fetch(base + '/?range=month&cb=' + Date.now())).text();
push('筛选/分页视图 noindex,follow（不与首页抢收录）', /<meta name="robots" content="noindex,follow">/.test(filtHtml), '');
const listHtml = await (await fetch(base + '/articles?cb=' + Date.now())).text();
push('/articles 带 ItemList 结构化数据', /"@type":"ItemList"/.test(listHtml), '');

push('/articles 卡片是 article + 标题内链（锚文本=标题）',
  artHtml.includes('<article class="acard" data-id=') && artHtml.includes('class="stretch"') && !artHtml.includes('<a class="acard" href='), '');
push('首页「阅读全文」不再是链接（装饰 span + aria-hidden）',
  home.includes("read.setAttribute('aria-hidden','true')") && !home.includes('read.href=artHref'), '');

push('首页只剩一份卡片渲染器（复用 artCardEl）',
  (home.match(/className='artcard'/g) || []).length === 1 && /grid\.appendChild\(artCardEl\(it\)\)/.test(home) && !home.includes('artcard-mins'), '');

const deadStatus = [];
for (const p of ['/js/app.js', '/js/api.js', '/js/ui.js', '/js/state.js']) {
  const rr = await fetch(base + p + '?cb=' + Date.now());
  deadStatus.push(p + '=' + rr.status);
}
push('旧模块文件已删除（请求返回 404）', deadStatus.every((x) => /\=404$/.test(x)), deadStatus.join(' '));

push('首页不再急加载 md.js（改成 ensureMd 按需）',
  !/<script[^>]+src="\/?js\/md\.js"/.test(home) && home.includes('function ensureMd()'), '');

push('文章视图空态有「为什么空 + 三个出口」',
  home.includes('function artEmptyHtml(') && home.includes('data-avf="all"') && home.includes('当前筛选：'), '');

push('首页空态说清筛选并提供两个出口',
  bundleJs.includes('当前筛选：') && bundleJs.includes('只清关键词') && bundleJs.includes('清空全部筛选') && bundleJs.includes('这次抓到的 '), '');

const liveMetaTxt = await (await fetch(base + '/data/repos-meta.js?cb=' + Date.now())).text();
const liveGen = (liveMetaTxt.match(/generatedAt:\s*"([^"]+)"/) || [])[1] || '';
const liveAgeH = liveGen ? (Date.now() - Date.parse(liveGen)) / 3600000 : NaN;
push('线上数据是新的（3 小时抓取链路还活着）', Number.isFinite(liveAgeH) && liveAgeH <= 6,
  'generatedAt=' + liveGen + ' / 距今 ' + (Number.isFinite(liveAgeH) ? liveAgeH.toFixed(1) + ' 小时' : '未知'));

push('后台有「收录自查」卡片', admHtml.includes('id="indexCheck"') && admHtml.includes('/api/index-check'), '');
{
  const r = await fetch(base + '/api/index-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"/"}' });
  push('收录自查接口要密码（不带密码 403）', r.status === 403, 'HTTP ' + r.status);
}

push('自查能解释「为什么跳过」（这批地址指纹）', admHtml.includes('这批地址') && admHtml.includes('sigSame'), '');

push('收录自查窄屏改成上下排（标签在上）', admHtml.includes('.ick-i{display:block}') && admHtml.includes('@media (max-width:480px)'), '');
push('sitemap 读不到时不再判「没被收录」', admHtml.includes('这一项不能当成「没被收录」'), '');

push('收录自查支持批量（textarea + 表格）', admHtml.includes('id="ickBatch"') && admHtml.includes('ick-tw'), '');
push('批量入口写明了上限', admHtml.includes('一次最多 20 条，一行一条'), '');

push('批量查支持一键填入 sitemap 地址', admHtml.includes('id="ickFillSitemap"'), '');
push('宽表旁边提示可左右滑动', admHtml.includes('ick-hint'), '');

push('后台有「最近查询记录」块（可展开）', admHtml.includes('id="ickLogWrap"') && admHtml.includes('id="ickLogBox"'), '');
push('收录记录每行有动作按钮（推 / 重查）', admHtml.includes('data-ickpush') && admHtml.includes('data-ickre'), '');
push('收录记录上方有「今天 vs 昨天」摘要', admHtml.includes('id="ickTrend"') && admHtml.includes('把挂着的填进批量框'), '');

push('后台有「定时自查」块与可粘贴的配置片段', admHtml.includes('id="cronWrap"') && admHtml.includes('id="cronSnippet"') && admHtml.includes('/api/index-cron'), '');

push('后台能填定时令牌（输入框 + 生成 + 保存 + 状态行）', admHtml.includes('id="seo-indexCronToken"') && admHtml.includes('id="cronTokGen"') && admHtml.includes('id="cronTokState"'), '');

{
  const rs = await fetch(base + '/api/site');
  const sj = await rs.text();
  push('站点接口只给令牌哈希（不回明文）', rs.status === 200 && sj.indexOf('"indexCronToken"') < 0 && sj.indexOf('indexCronTokenHash') >= 0, 'HTTP ' + rs.status);
}

{
  const r = await fetch(base + '/api/index-cron', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const txt = await r.text();
  push('定时自查接口要令牌（没配令牌 400 / 令牌不对 403 / 口令错 403）', r.status === 400 || r.status === 403, 'HTTP ' + r.status + ' ' + txt.slice(0, 60));
}
{
  const rp = await fetch(base + '/api/index-push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  push('单条推 IndexNow 要密码（不带密码 403）', rp.status === 403, 'HTTP ' + rp.status);
}
{
  const rl = await fetch(base + '/api/index-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  push('收录历史接口要密码（不带密码 403）', rl.status === 403, 'HTTP ' + rl.status);
}

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
