# SEO / GEO 全站规划（GitHub 热门项目排行榜）

> 站点：https://github.661026.xyz　技术栈：Cloudflare Worker（单文件后端）+ 纯静态前端 + GitHub Actions 每 3 小时更新数据
> 目标：① 被搜索引擎正常收录并拿到长尾流量　② 被 AI 搜索（豆包 / 通义 / 元宝 / Kimi / Perplexity / ChatGPT Search）当作可信来源引用

## 0. 现状体检（改前）

| 项 | 现状 | 结论 |
| --- | --- | --- |
| `robots.txt` | 18 个 AI 爬虫全部 Allow，带 Sitemap | ✅ 已就位 |
| `sitemap.xml` | 动态生成，含 `/`、`/nav`、`/articles` 与文章条目，带 lastmod | ✅ 已就位 |
| `llms.txt` | 站点简介 / 核心页面 / 数据口径 / 机器可读接口 / 引用建议 | ✅ 已就位 |
| 文章链接 | 原为 `/articles#1795584786860` | ❌ 数字锚点，收录价值低 → **本轮改成 `/articles/<slug>`** |
| 结构化数据 | 首页 JSON-LD（WebSite + SearchAction） | ⚠️ 文章页缺 `Article` 结构化数据 |
| 可索引内容 | 文章目前只有几篇 | ❌ 内容量太少，是最大瓶颈 |
| 内链 | 首页 ↔ 导航 ↔ 文章三页互链 | ⚠️ 文章之间没有内链（只有上一篇/下一篇） |

## 1. URL 与可抓取性（已完成 + 待补）

已完成：
- 文章永久链接改为 `/articles/<slug>`，slug 自动由英文标题生成（`Blog Layout Test 2026` → `blog-layout-test-2026`），后台可手填覆盖；重名自动加 `-2`。
- Worker 对 `/articles/<任意合法 slug>` 直接返回文章页（前端按路径里的 slug 打开对应文章）。
- sitemap 输出 slug 链接，`<lastmod>` 取文章日期。

已补齐（第 19 轮核对，带证据）：
- 文章页 `<link rel="canonical">` 与 `og:url` 随 slug 变化 ✅ —— `/articles/tech/4.html` 的两个地址都指向它自己。
- 分页与筛选参数一律 `noindex,follow` ✅ —— `?range=month`、`?page=2`、`?q=rust`、`?cat=ai`、`?lang=en` 实测都是 `noindex,follow`，canonical 回首页，响应 `cache-control: no-store`（视图变体不进边缘缓存）。
- `?page=articles` 这类**视图路由**不误伤 ✅ —— 它不是分页，仍 `index,follow`。

## 2. 内容策略（决定 80% 效果）

搜索与 AI 都吃「有信息增量」的内容。建议固定三个栏目，每周 2–3 篇：

1. **榜单解读**：每周「本周新增星标 Top 10」「本周飙升最快的 5 个项目」，引用站内数据（数字 + 对比）。
2. **项目深评**：单仓库 800–1500 字，讲清「解决什么问题 / 和同类比怎样 / 上手成本 / 适合谁」。
3. **主题合集**：如「AI Agent 框架 12 个」「Rust 写的 CLI 工具 20 个」，天然长尾。

每篇必须有的元素：唯一 H1、摘要（120 字内）、3 个以上小标题（H2）、至少一张表格或列表、文末「相关阅读」2–3 条内链、`category` + `tags`（分类页与标签页可后续再加）。

## 3. 结构化数据

- 首页：保留 WebSite + SearchAction。
- 文章页：注入 `Article` / `BlogPosting`（headline、datePublished、dateModified、author、publisher、image、mainEntityOfPage）。
- 列表页：`ItemList`（前 20 个项目，含 name/url）。
- 面包屑：`BreadcrumbList`（首页 › 文章 › 当前篇）。
- FAQ：关于本站的问答改成 `FAQPage`（AI 搜索特别喜欢抓）。

## 4. 性能与 Core Web Vitals

已做：边缘缓存（HTML 300s / 数据 600–900s / 配置 60s）、静态资源 `?v=` 版本化 + immutable、`Link: rel=preload`、数据按 range 拆包、gzip/br、HTTP/2。

待做：
- 文章页首屏图片加 `width/height` 与 `loading="lazy"`（防 CLS）。
- 字体用 `font-display: swap`（已在用系统字体则忽略）。
- LCP 元素（标题或统计卡）避免被广告位挤动 → 广告位统一 `min-height`。

## 5. 站内 SEO 细节清单

- [x] 每页唯一 title / description（Worker 按 site.json 注入）
- [x] canonical、og:url、og:image、twitter:card
- [x] `/nav` 导航页与首页互链
- [x] 文章页 `<title>` 服务端注入（`/articles/tech/4.html` → `目录高亮验证 · GitHub 热门项目排行榜`）
- [x] 404 页面（`notFoundPage()`：404 状态 + `robots noindex` + 四个入口）
- [x] 图片 alt（`check-media` 17 项：可见图都有 alt 与固有尺寸，装饰图 `alt=""`）
- [x] 文章列表 `ItemList` 结构化数据（`/articles` 注入前 20 篇）
- [ ] 内链锚文本多样化（现在列表卡统一是「阅读全文」）

## 6. GEO（AI 搜索）专项

AI 搜索的引用逻辑：**结构清晰 + 事实密度高 + 有明确来源与时间**。具体动作：

1. `llms.txt` 已有 → 再补一段「本站数据口径与免责声明」，AI 引用时更敢用。
2. 每篇文章开头加 2–3 句「结论前置」摘要（AI 抽取概率最高）。
3. 数字必须标时间和来源：「截至 2026-11-25，该仓库 565,346 星（GitHub API）」。
4. 提供机器可读数据：`/data/repos-*.js` 已知；再暴露 `/api/status`（已做）与只读 JSON `/api/rank?range=week&limit=50`。
5. 主动提交：IndexNow（已做，Bing 系）+ 百度普通收录（已做）→ 再补：
   - Google Search Console：提交 sitemap，等自然抓取。
   - 字节（豆包）：`https://bsh.bytedance.com` 收录入口人工提交。
   - 通义/夸克：`https://quark.sm.cn` 站点提交。
   - 元宝/微信搜一搜：需要公众号或小程序主体，暂缓。
6. 建「关于数据」页：数据来源、更新频率、口径、引用格式（`本站数据来源于 GitHub API，采集于 YYYY-MM-DD`），AI 引用时会带走这句。

## 7. 收录与监测

| 渠道 | 动作 | 频率 |
| --- | --- | --- |
| Bing / IndexNow | 后台「收录提交」一键推 | 每次发文章后 |
| 百度普通收录 | 同上（每天配额有限，见返回 `remain`） | 每篇 1 次 |
| Google Search Console | 人工提交 sitemap + URL 检查 | 每周 |
| 站点日志 | 暂无（Worker 不存日志）→ 用 CF Analytics 看 4xx/5xx 与 bot 占比 | 每周 |

验收指标（3 个月）：
- 收录页数 ≥ 30（当前 ~3）
- 自然搜索点击 ≥ 50/周
- AI 搜索引用 ≥ 3 次/月（手动在豆包/通义/Perplexity 搜站内独有标题验证）

## 8. 本轮已落地（代码）

- 文章 slug：`slugify()`、`checkArticle` 校验（`^[a-z0-9][a-z0-9-]{0,59}$`）、新增/编辑自动生成与去重、sitemap 用 slug、Worker 路由 `/articles/<slug>`。
- 文章级「如何获取密码」提示 `unlockHint`（≤300 字），前台密码弹窗与阅读页锁定态都会显示；站点默认提示存 `site.article.unlockHint`。
- 前端路由：卡片/上一篇/下一篇链接改为 `/articles/<slug>`，`pushState` 同步，`/articles/<slug>` 直开、返回列表回到 `/articles`。
- 自检：`node scripts/check-articles.mjs`（起本地 dev-server，真建一篇带 slug 与提示的加密文章 → 校验 slug 生成、提示落库、`/articles/<slug>` 200、sitemap 含 slug 链接，跑完自动还原数据）。

## 9. 下一步（按优先级）

1. 文章页服务端注入 canonical / og:url / Article JSON-LD（Worker 按 slug 渲染 head）。
2. 分类页与标签页（`/articles?cat=xxx` → 独立可索引页）。
3. `/api/rank` 只读 JSON 接口。（**未做**：要先定去重与配额规则，避免变成免费的全量数据出口；当前机器可读入口是 `/api/status`、`/data/repos-*.js` 与 `/data/articles.json`。）
4. 「关于数据」页 + 引用格式。
5. 内容日历：先攒 20 篇再谈外链与推广。
