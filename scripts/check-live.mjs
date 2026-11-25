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
push('文章页侧栏标题改 h2', art.includes('<h2>关于本站</h2>') && !art.includes('<h4>关于本站</h4>'));
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
push('文章列表页有分页条', artListHtml.includes('id="apager"') && artListHtml.includes('var PER = 9;'), '');
push('首页文章卡片有置顶徽标代码', home.includes('pinchip'), '');
push('首页最新文章最多 6 篇', home.includes('var HOME_MAX=6;'), '');
push('导航分组可折叠并记住状态', home.includes('class="gtog"') && home.includes('ghrank-nav-closed'), '');
push('首页尊重「减少动效」偏好', home.includes('prefers-reduced-motion: reduce'), '');
push('榜单分页器有「跳到第 N 页」', home.includes('id="pgJump"') && home.includes('class="pjump"'), '');
push('跳页逻辑已绑定（bundle）', bundleJs.includes('goJump'), '');
push('榜单卡片键盘聚焦有高亮', home.includes(".item:focus-within"), '');
push('/articles 有返回顶部按钮', artListHtml.includes('id="totop"') && artListHtml.includes('initTotop'), '');
push('/articles 页脚有 RSS 订阅', artListHtml.includes('href="/rss.xml"'), '');
push('/articles 阅读器有进度条', artListHtml.includes('id="rprogress"') && artListHtml.includes('function paintProgress'), '');
const faqTotop = await (await fetch(base + '/faq?v=' + t)).text();
push('/faq 有返回顶部按钮', faqTotop.includes('id="totop"') && faqTotop.includes('initTotop'), '');
push('/faq 页脚有 RSS', faqTotop.includes('href="/rss.xml"'), '');
const admHtml = await (await fetch(base + '/admin?v=' + t)).text();
push('后台友链有上移/下移按钮', admHtml.includes('data-up=') && admHtml.includes('data-down='), 'bytes=' + admHtml.length);
push('后台问答行有上移/下移按钮', admHtml.includes('data-qaup=') && admHtml.includes('data-qadn='), '');
push('后台导航页有分类/站点上下移动', admHtml.includes('data-gup=') && admHtml.includes('data-sup='), '');
push('导航页有「还没有站点」空态', home.includes('导航页还没有站点'), '');

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
