# GitHub 热门项目排行榜

按星标、增速、活跃度展示 GitHub 热门仓库的静态网站，附带开发者榜、组织榜、中文简介和 README 译文、文章页和一个可视化后台。

- 数据每 3 小时由 GitHub Action 抓取一次，网站本身是纯静态页面。
- 服务端是一个 Cloudflare Worker（单文件 `worker.js`），负责页面转发、后台、代理 GitHub 接口和保活。
- 所有后台配置都存在仓库的 `data/` 目录里，不依赖数据库。

## 功能

**榜单**
- 时间范围（近 7 天、30 天、一年、全部）、语言、排序（星标、今日增量、活跃度、Fork、最近更新）、视图（仓库、开发者、组织）可以组合筛选，URL 参数会同步变化，可以直接分享。
- 搜索支持多个词，并自动把常用中文词（如「命令行」「前端」「游戏」）对应到英文主题。
- 变化榜：显示与上一次记录相比新进入和掉出的仓库。
- 收藏（保存在浏览器本地）、导出和导入收藏（JSON 文件）。有未导出的收藏改动时，关闭页面会提醒。
- CSV 导出、分享卡片、PWA（可安装、离线读取已缓存的页面）。

**仓库详情（抽屉）**
- 点开任意仓库，显示 Star、Fork、许可证、最近提交、Release、主要贡献者和 README。
- README 可切换中英文；中文译文由机器翻译得到，页面会标注。
- 详情通过 Worker 代理请求 GitHub，访客不需要自己的 Token。访客也可以在「设置」里填写自己的 GitHub Token，用自己的额度刷新。

**文章**
- 支持 Markdown（标题、列表、代码块、链接、图片链接），可以在后台编辑，也可以导入 `.md` 文件。
- 渲染前会转义 HTML，只放行 http(s) 链接和站内路径，不执行页面里的脚本。

**后台（`/admin`）**
- 用管理密码登录，可视化管理：概览（保活状态）、友链、广告位、榜单布局（自动 / 单栏 / 双栏）、联系方式（悬浮按钮）、备案信息、SEO、GEO（摘要与问答）、文章、翻译设置（显示 Cloudflare 里的配置状态；密钥需在 Cloudflare Secret 中设置）。
- 翻译设置页面只显示 Cloudflare 里是否已配置 GitHub Token，不能在页面上保存密钥。

**翻译**
- 简介和 README 的中文译文按顺序尝试：仓库里预翻译好的文件 → MyMemory（免 Key，可用邮箱提高额度）→ Workers AI（如果绑定了 AI）。全部失败时显示英文原文。

## 整体结构

```
index.html          页面结构和样式
articles.html       文章页
js/bundle.js        页面全部逻辑（普通脚本，直接用 file:// 也能加载）
js/md.js            Markdown 渲染（文章和 README 共用）
sw.js               Service Worker，缓存版本号 CACHE 在文件内
manifest.json       PWA 配置
icon.svg            图标
worker.js           Cloudflare Worker：页面转发、后台、API、保活、定时任务
scripts/fetch.js    抓取榜单、翻译简介和 README 的脚本（Node 20，无依赖）
serve.js            本地静态服务（只用于本机预览）
启动网页.bat         Windows 下双击启动本地预览
data/
  repos.js          榜单数据（Action 生成）
  desc-zh.json      简介中文译文（Action 和 Worker 共同维护）
  readme-zh.json    README 中文译文（Action 生成）
  site.json         站点设置：SEO、GEO、广告、联系方式、备案、榜单布局
  links.json        友情链接
  articles.json     文章
  .github/workflows/update-data.yml   定时抓取（每 3 小时）
```

## 数据如何流动

1. **榜单**：GitHub Action 每 3 小时运行 `scripts/fetch.js`，生成 `data/repos.js` 等文件。只有内容变化时才提交。也可以在 Actions 页面手动运行 `Update data`。
2. **访客打开页面**：Worker 从仓库的 raw 地址读取页面文件和数据，原样返回。页面脚本再请求抽屉详情、README 等接口，由 Worker 代为请求 GitHub 并缓存。
3. **后台保存**：管理员在 `/admin` 修改配置，Worker 使用 `GITHUB_TOKEN` 把修改提交到仓库的 `data/` 目录，约 5 分钟后前台生效。
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
