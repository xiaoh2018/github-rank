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

const bundleJs = await (await fetch(base + '/js/bundle.js?v=' + t)).text();
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
push('阅读器标题窄屏 23px', artText.includes('.reader h1{font-size:23px'), '');
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
push('分类胶囊有统一视觉（实心选中 + 圆角 + hover）', home.includes('.chip.is-on{background:var(--accent)') && home.includes('.chip:hover{border-color:var(--accent)') && home.includes('function paintChipBox'), '');
push('文章页胶囊与首页同一套样式', artText.includes('.chip.is-on{background:var(--accent)') && artText.includes('.chip:hover{border-color:var(--accent)'), '');
push('问答页胶囊选中改为实心（与首页一致）', faqText.includes('.chip.is-on{background:var(--accent)') && faqText.includes('.chip:hover{border-color:var(--accent)'), '');
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
push('错误卡给「重试 / 稍后再看」并安抚本地数据', bundleJs.includes("el('button', 'btn', '重试')") && bundleJs.includes("el('button', 'btn ghost', '稍后再看')") && bundleJs.includes('收藏和主题设置存在你自己的浏览器里'), '');
push('静态数据没读到会立刻改说实时拉取', bundleJs.includes('静态数据没读到，正在从 GitHub 实时拉取') && bundleJs.includes('还在拉取…GitHub 响应有点慢'), '');
push('后台保存有常驻状态行（不再是 toast）', admHtml.includes('.save-msg.err{color:var(--bad)}') && admHtml.includes('function saveRun') && admHtml.includes("setAttribute('role', 'status')"), '');
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

push('文章卡片列数可设置（首页）', home.includes('body[data-artcols="triple"] .artgrid') && home.includes('applyArtCols'));
push('文章页跟随列数设置', artListHtml.includes('html[data-artcols="double"] .cards'));
push('后台有列数开关', admHtml.includes('type="radio" name="article-cols"') && admHtml.includes('文章卡片列数'));

push('文章详情是页内阅读器（不再跳 /articles/xxx.html）', home.includes('id="artDlg"') && home.includes('class="artdlg"') && home.includes('data-artpost'));
push('文章详情地址用 ?post= 深链（bundle 也保留它）', home.includes('/?page=articles&post=') && bundleJs.includes("get('post')"));
push('空正文有明确说明（不是白屏）', home.includes('这篇还没有正文'));
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
push('数据瘦身：时间戳是 epoch 秒', /"updated":1[6-9][0-9]{8}/.test(weekJs));
push('首页预载周榜数据（与 script 地址一致）', bundleJs.indexOf('s.src = file;') >= 0 && bundleJs.indexOf('function repoUrl(r)') >= 0);
const navHtml = await (await fetch(base + '/nav?t=' + t)).text();
const artHtml = await (await fetch(base + '/articles?t=' + t)).text();
const faqHtml = await (await fetch(base + '/faq?t=' + t)).text();
push('导航页有自己的标题与 canonical（不是首页副本）', navHtml.indexOf('站点导航 · ') >= 0 && navHtml.indexOf('rel="canonical" href="' + base + '/nav"') >= 0);
push('文章页有完整分享卡', artHtml.indexOf('property="og:url" content="' + base + '/articles"') >= 0 && artHtml.indexOf('name="twitter:card"') >= 0);
push('问答页有完整分享卡', faqHtml.indexOf('property="og:url" content="' + base + '/faq"') >= 0 && faqHtml.indexOf('name="twitter:card"') >= 0);
let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
