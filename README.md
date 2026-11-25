# GitHub 热门项目排行榜

按星标、增速、活跃度展示 GitHub 热门仓库的静态网站，附带开发者榜、组织榜、中文简介和 README 译文、文章页和一个可视化后台。

- 数据每 3 小时由 GitHub Action 抓取一次，网站本身是纯静态页面。
- 服务端是一个 Cloudflare Worker（单文件 `worker.js`），负责页面转发、后台、代理 GitHub 接口和保活。
- 所有后台配置都存在仓库的 `data/` 目录里，不依赖数据库。

## 功能

**榜单**
- 时间范围（近 7 天、30 天、一年、总榜）、语言、排序（星标、今日增量、活跃度、Fork、最近更新）、视图（仓库、开发者、组织）可以组合筛选，URL 参数会同步变化，可以直接分享。前三个范围按**创建时间**圈出「新项目」再按星标排；**总榜**不分创建时间，是 GitHub 全站星标降序前 500（深翻 10 页抓取）。
- 搜索支持多个词，并自动把常用中文词（如「命令行」「前端」「游戏」）对应到英文主题。
- 变化榜：显示与上一次记录相比新进入和掉出的仓库。
- 收藏（保存在浏览器本地）、导出和导入收藏（JSON 文件）。有未导出的收藏改动时，关闭页面会提醒。
- CSV 导出、分享卡片、PWA（可安装、离线读取已缓存的页面）。

**仓库详情（抽屉）**
- 点开任意仓库，显示 Star、Fork、许可证、最近提交、Release、主要贡献者和 README。
- README 直接渲染成排版后的样子（标题、表格、图片、代码块、任务清单），超长时给「在 GitHub 看完整 README」的入口。
- README 可切换中英文；中文译文由机器翻译得到，有译文时标注「机器翻译 · 仅供参考」，译文到达时只替换 README 区块，不打断阅读。
- 详情通过 Worker 代理请求 GitHub，访客不需要自己的 Token。访客也可以在「设置」里填写自己的 GitHub Token，用自己的额度刷新。

**文章**
- 支持 Markdown（标题、列表、任务清单、表格、代码块、删除线、链接、图片链接），可以在后台编辑，也可以导入 `.md` 文件；后台写文章是「左边写、右边实时预览」的双栏弹窗。
- 渲染前会转义 HTML，只放行 http(s) 链接和站内路径，不执行页面里的脚本。

**导航页**
- 页头有两个标签：榜单 / 导航。导航页按分类展示常用站点卡片（图标 + 名称 + 描述 + 域名），带搜索框，数据来自 `data/nav.json`。
- 后台可以加分类、加站点；填网址点「自动获取」会把网页标题、描述、图标抓回来（抓不到自己写）。

**后台（`/admin`）**
- 用管理密码登录，11 个标签按「常用 / 内容 / 站点信息 / 运维」分组：概览、榜单布局、文章、SEO 与 GEO、友链、导航页、广告、联系方式、备案信息、收录提交、翻译与密钥。
- 广告有 5 个位置（首页顶部、榜单上方、榜单下方、侧栏底部、文章区上方），每个位置独立开关，不勾就不渲染。
- 收录提交：一键走 IndexNow（Bing / Yandex / Seznam / Naver），配 `BAIDU_TOKEN` 时也会推百度；面板上直接给出 `/sitemap.xml`、`/llms.txt` 与 key 文件的地址。
- 密钥（GitHub Token、百度 Token 等）只在 Cloudflare 的 Variables and Secrets 里设置，后台只显示「配没配」并可以实测翻译链路。

**翻译**
- 简介和 README 的中文译文按顺序尝试：仓库里预翻译好的文件 → 边缘缓存里已有的译文 → MyMemory（免 Key，可用邮箱提高额度）→ Workers AI（如果绑定了 AI）。全部失败时显示英文原文。
- 长文本会自动分段（MyMemory 450 字/段、Workers AI 900 字/段），失败原因会分类显示（网络 / 额度 / HTTP / 解析 / 没绑定）。

**被搜索引擎与 AI 搜索收录**
- `/robots.txt` 明确放行 18 个 AI 爬虫（GPTBot、ClaudeBot、PerplexityBot、Bytespider、Qwen-Bot、DeepSeek-Bot 等）。
- `/llms.txt` 是给大模型的站点说明书（页面、最新文章、导航分类、数据来源都写清楚）。
- `/sitemap.xml` 含首页、文章页和每篇文章的锚点，带 `lastmod`。

## 整体结构

```
index.html          页面结构和样式
articles.html       文章页
js/bundle.js        页面全部逻辑（普通脚本，直接用 file:// 也能加载）
js/md.js            Markdown 渲染（文章和 README 共用）
sw.js               Service Worker，缓存版本号 CACHE 在文件内
manifest.json       PWA 配置
icon.svg            图标
og-image.png        社交分享图（1200×630，由 scripts/make-og-image.ps1 生成）
worker.js           Cloudflare Worker：页面转发、后台、API、保活、定时任务
scripts/fetch.js    抓取榜单、翻译简介和 README 的脚本（Node 20，无依赖）
scripts/split-data.js        把旧的合并数据文件拆成按时间范围的新格式（迁移用）
scripts/make-og-image.ps1    生成 og-image.png（Windows 自带 GDI+，无需额外依赖）
scripts/check-worker.mjs     本地模拟 Workers 运行时跑 13 组自检（node scripts/check-worker.mjs）
scripts/dev-server.mjs       本地真的跑 worker.js（http://127.0.0.1:8123，后台密码 dev）
scripts/preview-admin.mjs    生成后台各面板的预览页（自动用 dev 密码登录，便于截图核对）
wrangler.toml       Cloudflare 部署配置（路由也在里面，避免部署时丢路由）
serve.js            本地静态服务（只用于本机预览）
启动网页.bat         Windows 下双击启动本地预览
data/
  repos-meta.js     榜单元信息（生成时间、各范围条数、开发者与组织榜）
  repos-week.js     近 7 天榜（Action 生成）
  repos-month.js    近 30 天榜（Action 生成）
  repos-year.js     近 1 年榜（Action 生成）
  repos-total.js    总榜：全站星标降序前 500（深翻 10 页抓取，Action 生成）
  repos-all.js      旧「全部」榜，已停更，仅作旧链接兜底
  repos.js          旧版合并数据，已冻结，仅作新 Worker 部署前的兜底
  desc-zh.json      简介中文译文（Action 和 Worker 共同维护）
  readme-zh.json    README 中文译文（Action 生成）
  site.json         站点设置：SEO、GEO、广告（5 个位置）、联系方式、备案、榜单布局
  links.json        友情链接
  articles.json     文章
  nav.json          导航页：分类 + 站点卡片
  .github/workflows/update-data.yml   定时抓取（每 3 小时）
  .github/workflows/deploy-worker.yml 改了 worker.js 自动部署（需配 CLOUDFLARE_API_TOKEN）
```

## 数据如何流动

1. **榜单**：GitHub Action 每 3 小时运行 `scripts/fetch.js`，生成 `data/repos-meta.js`（元信息 + 开发者/组织榜）和 `data/repos-week.js`、`repos-month.js`、`repos-year.js`、`repos-total.js`（每个范围一个文件，页面只下载当前选中的那一个）。前三个范围按创建时间分段搜索、总榜走 `stars:>1000 sort=stars` 深翻 10 页。只有内容变化时才提交。也可以在 Actions 页面手动运行 `Update data`。
2. **访客打开页面**：Worker 从仓库的 raw 地址读取页面文件和数据，把**成品响应**写进边缘缓存（Cache API）：命中时直接返回，既不回源也不重新拼页面；未命中才回源一次，之后按文件类型带长缓存、`ETag` 和 `stale-while-revalidate`。页面脚本再请求抽屉详情、README 等接口，由 Worker 代为请求 GitHub 并缓存。
3. **后台保存**：管理员在 `/admin` 修改配置，Worker 使用 `GITHUB_TOKEN` 把修改提交到仓库的 `data/` 目录，并顺手清掉相关成品缓存，刷新即可看到。
4. **保活**：Cron 每周一 UTC 02:00（北京时间 10:00）运行一次，检查保活状态并记录时间。

## 部署

以下步骤假设你已有 GitHub 账号和 Cloudflare 账号。

### 1. Fork 或复制仓库

把仓库 Fork 到你自己的 GitHub 账号下。之后所有数据都会写进你自己的仓库。

### 2. 修改 GitHub Action 的权限

仓库 Settings → Actions → General → Workflow permissions，选择 **Read and write permissions**，否则 Action 无法提交数据。

### 3. 创建 GitHub Token（用于后台保存和触发 Action）

GitHub → Settings → Developer settings → Fine-grained tokens，创建一个只针对你这个仓库的 Token，权限：

- Contents：Read and write
- Actions：Read and write
- Metadata：Read-only

### 4. 创建 Cloudflare Worker

1. Cloudflare 后台 → Workers & Pages → Create → Worker，名字例如 `github-rank`。
2. 点 **Edit code**，把仓库里的 `worker.js` 全部粘贴进去，点 **Deploy**。
3. 进入该 Worker 的 **Settings → Variables and Secrets**，添加：

| 名称 | 类型 | 说明 |
|---|---|---|
| `REPO_OWNER` | Text | 你的 GitHub 用户名 |
| `REPO_NAME` | Text | 仓库名，例如 `github-rank` |
| `ADMIN_PASSWORD` | Secret | 后台登录密码，由你自己设定。不设置则后台关闭 |
| `GITHUB_TOKEN` | Secret | 第 3 步创建的 Token |
| `RUN_PASSWORD` | Secret | 可选，手动保活页的密码 |
| `TRANSLATE_EMAIL` | Text | 可选，MyMemory 用的邮箱，用于提高免费额度 |
| `STALE_HOURS` | Text | 可选，数据超过几小时才允许访客触发抓取，默认 6 |
| `COOLDOWN_MINUTES` | Text | 可选，两次触发抓取的最短间隔，默认 60 |

4. 绑定 Workers AI（可选）：Settings → Bindings → Add → Workers AI，变量名保持 `AI`。不绑定时翻译会跳过这一步。
5. 定时任务：Settings → Triggers → Cron Triggers，添加 `0 2 * * 1`（用于每周保活）。

### 5. 首次运行抓取

GitHub 仓库 → Actions → `Update data` → Run workflow。成功后 `data/repos.js` 会生成，网站即可显示榜单。

### 6. 打开网站

访问 `https://<你的 Worker 名>.<你的子域>.workers.dev/`。

访问 `/admin` 用 `ADMIN_PASSWORD` 登录，然后在后台填写网站名称、SEO、友链、联系方式等。

## 本地预览

需要 Node.js 20 或更高版本，没有其他依赖。

```bash
node serve.js
```

然后打开 http://localhost:8080 。Windows 下也可以双击 `启动网页.bat`。

本地预览没有 Worker，所以后台、抽屉详情、中文译文接口不可用，页面会显示「暂时读取不到」，这是预期行为。要测试这些功能，需要部署 Worker。

## 手动抓取数据（可选）

```bash
GITHUB_TOKEN=你的Token node scripts/fetch.js
```

不设置 `GITHUB_TOKEN` 也能运行，只是速度慢、额度少。可选的环境变量：`TRANSLATE_EMAIL`。

## 安全说明

- 仓库里不包含任何明文密码或 Token。管理密码、GitHub Token 只存在 Cloudflare Secret 中。
- GitHub Token 只放在 Cloudflare 的 Secret 里（`GITHUB_TOKEN`），不写入仓库。
- 访客刷新时只读取公开数据，不需要任何权限。Worker 代理的接口有路径白名单，不是通用代理。
- 发现安全问题请通过 GitHub Issue 或私信联系，不要在公开 Issue 里贴出密钥。

## 常见问题

**网站打开是空白或没有榜单？**
确认 Action 已经运行成功，并且 `data/repos.js` 存在。另外检查 Worker 的 `REPO_OWNER`、`REPO_NAME` 是否填对。

**后台提示「未配置」或登录失败？**
`ADMIN_PASSWORD` 没有设置或拼写不对。修改后需要重新部署或等待 Worker 更新。

**保存配置后前台没变化？**
前端文件和数据有缓存，约 5 分钟后生效。浏览器里可以强制刷新（Ctrl+F5）。

**Action 提示没有权限？**
检查 Workflow permissions 是否为 Read and write，以及 `GITHUB_TOKEN` 的 Contents 和 Actions 权限。

**翻译一直是英文？**
MyMemory 的免费额度有限，额度用完时会改用 Workers AI（需绑定 AI）。仍然失败的段落会显示英文原文。

**本地预览看不到抽屉详情？**
这是预期行为，抽屉依赖 Worker 接口，部署 Worker 后即可使用。

## 许可证

本项目使用 MIT 许可证，详见仓库根目录的 `LICENSE` 文件。
