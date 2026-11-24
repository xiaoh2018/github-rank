# github.661026.xyz 加速评估报告

> 测量时间：2026-11-24 17:14–17:16（北京时间，测量点：中国大陆家宽，经 HKG 边缘节点）
> 测量对象：`https://github.661026.xyz/`（Worker + 路由 `github.661026.xyz/*`）
> 对照域名：`github.cloudflare.182682.xyz`（所谓"优选域名"）
> 结论先行：**协议栈已经顶配（TLS 1.3 + HTTP/2 + Brotli + h3 通告），真正的速度瓶颈不在 CDN，而在"每个请求回源一次 GitHub raw（约 300ms）+ 首屏一次性灌 403KB 数据 + 全站 5 分钟缓存"三件事上。而那个优选域名实测是无效且不可用的。**

---

## 1. 实测数据

### 1.1 协议与边缘

| 项目 | 实测值 | 评价 |
|---|---|---|
| HTTP 版本 | `h2`（ALPN 协商成功） | ✅ 已是最优，无需动 |
| TLS 版本 | `TLSv1.3` | ✅ 已最优 |
| 压缩 | `br` / `gzip` 都支持 | ⚠️ 见 1.4，这里反而有坑 |
| HTTP/3 | `alt-svc: h3=":443"; ma=86400` | ✅ 已通告，浏览器会自动升级 QUIC |
| 证书 | `CN=661026.xyz`，校验通过 | ✅ 正常 |
| 边缘节点 | `CF-RAY: ...-HKG`（香港） | ✅ 对华南/华东最优，北方可能落到 SIN/LAX |
| 源站 | `raw.githubusercontent.com`（美国） | ❌ 每次未命中要跨太平洋 |

### 1.2 TTFB（首字节）

| 场景 | 实测 | 说明 |
|---|---|---|
| 冷连接首个请求 `/`（含 TLS 握手） | 443ms | 300ms 握手 + 140ms Worker |
| 复用连接 `/`（Worker 命中内层缓存） | 104–122ms | 这是 Worker 的正常热路径 |
| 复用连接 `/`（Worker 未命中） | 390–443ms | **多出来的 300ms = 回源 raw.githubusercontent** |
| `/js/bundle.js` 命中 | 111ms | |
| `/js/md.js` 未命中 | 386ms | |
| `/manifest.json` 未命中 | 418ms | 一个 217 字节的文件花了 418ms |
| `/api/status` | 996ms | 串行调 GitHub API 两次 |

**关键发现**：同一个 Worker、同一个连接，命中时 110ms、未命中时 400ms。**每个未命中的静态文件都在替美国源站交 300ms 的过路费**，而 CF 的边缘只缓存了"回源的那次 fetch"，没有缓存"最终吐给浏览器的响应"。

### 1.3 首屏传输预算（Brotli，实测逐文件）

| 文件 | 传输体积 | 占比 | 耗时 |
|---|---|---|---|
| `/data/repos.js` | **402.9 KB** | **93.4%** | 1248ms |
| `/js/bundle.js` | 20.2 KB | 4.7% | 111ms |
| `/`（HTML，CSS 全内联） | 13.0 KB | 3.0% | 443ms |
| `/js/md.js` | 2.2 KB | 0.5% | 386ms |
| `/data/site.json` | 1.7 KB | 0.4% | 128ms |
| `/sw.js` | 970 B | 0.2% | 392ms |
| `/manifest.json` + `/icon.svg` + `links.json` + `articles.json` | 508 B | 0.1% | 124–418ms |
| **合计** | **431.2 KB** | | **约 1.3–2.0s 才能出完整首屏** |

`repos.js` 一个文件吃掉 93% 的流量和几乎全部等待时间。

### 1.4 压缩的意外结论

| 文件 | gzip | br | 谁更小 |
|---|---|---|---|
| `/` | 12,116 B | 13,048 B | gzip 小 7% |
| `/data/repos.js` | 394,467 B | 402,922 B | gzip 小 2% |
| `/js/bundle.js` | 18,788 B | 20,198 B | gzip 小 7% |

Cloudflare 对这类文本给出的 Brotli 反而比 gzip 大。原因是 br 是在边缘动态压缩的（低质量档），gzip 命中了更好的路径。**这点不值得你动手改**（客户端协商由 CF 决定），但说明"用 br 就能更快"在这个站是不成立的。

### 1.5 缓存头：全站一律 5 分钟

```
Cache-Control: public, max-age=300
（无 ETag、无 Last-Modified、无 s-maxage、无 stale-while-revalidate、无 cf-cache-status）
```

后果三条：

1. `bundle.js`（20KB）、`md.js`、`icon.svg`、`manifest.json` 这些**一年都不会变**的 shell 文件，每 5 分钟就可能被浏览器重新下载一遍；
2. 没有 `ETag`，浏览器连 304 协商都做不了，只能全量重下；
3. 响应里没有 `cf-cache-status`，说明 **Worker 的成品响应完全没进 CF 的 HTTP 缓存**，每次请求都要 Worker 跑一遍。

---

## 2. 优选域名评估：实测无效，且当前不可用

你绑的 `github.cloudflare.182682.xyz`，三项实测结果：

### 2.1 它自己根本打不开

| 测试 | 结果 |
|---|---|
| `https://github.cloudflare.182682.xyz/` | `SSL alert number 40`（handshake_failure）——CF 边缘没有这个主机名的证书 |
| `http://github.cloudflare.182682.xyz/`（80 端口） | `error code: 1001`（DNS resolution error） |

也就是说这个域名**没有被配置成任何可用入口**，它只是个 DNS-only 的 CNAME 中转站。

### 2.2 它给你的 IP 和本站自己的一模一样

```
github.661026.xyz               → 172.66.143.239, 172.66.215.173, 172.67.205.252, 104.25.246.254, 104.25.253.202
github.cloudflare.182682.xyz    → 172.66.143.239, 172.66.215.173, 172.67.205.252, 104.25.246.254, 104.25.253.202
```

**完全同一组 5 个 anycast IP**。Cloudflare 不按 zone 分配边缘 IP（除非企业版独立 IP），所以"CNAME 到优选域名"这个动作对路由**零收益**——你本来解析出来就是这些 IP。

### 2.3 反证：真正的路由靠 SNI，不靠域名

直连 `172.66.143.239`，SNI 分别带两个名字：

| SNI | 结果 |
|---|---|
| `github.cloudflare.182682.xyz` | ❌ alert 40 |
| `github.661026.xyz` | ✅ TLS1.3 / h2 / 证书 `CN=661026.xyz` |

**结论**：CF 边缘是按 SNI 找 zone 的。你的站点能跑，是因为 `github.661026.xyz` 在你自己的 zone 里、证书在你自己的 zone 里。那个优选域名从头到尾只提供了一个和默认解析相同的 IP 列表，没有任何加速作用。

### 2.4 真想"优选"，三条正路

| 方案 | 做法 | 收益 | 代价 |
|---|---|---|---|
| A. 硬编码优选 IP（最简单） | 在 `661026.xyz` 的 DNS 里给 `github` 加 **A 记录**，直接填你测出来三网延迟最低的 CF IP（不要 CNAME 到别人域名，CF 会把 CNAME flatten 回同一组 anycast IP，等于白干） | 只影响"最后一公里"选哪条 BGP 路径，通常 0–80ms | 要自己维护 IP，IP 会漂 |
| B. Cloudflare for SaaS | 在 182682 那个账号下用「自定义主机名」把 `github.661026.xyz` 挂上去 | 能真的走那条链路并拿到证书 | 配置复杂，且仍受 CF 全局 anycast 调度，收益仍是"碰运气" |
| C. Cloudflare 中国网络 | 企业版 + ICP 备案，走与京东云合作的国内节点 | **真正的 CN 加速，RTT 从 40–60ms 降到 10–20ms** | 企业版费用 + 备案主体 |

免费版**没有** CN 专线，任何"优选"本质上都是挑一条不那么堵的国际线路，天花板就在那里。你现在的 HKG 已经是免费版能给到的好结果了。

---

## 3. 优化清单（按收益排序，都能自己改）

### P0-1 缓存"成品响应"而不是"回源请求"（收益最大，半天工作量）

**现状**：`worker.js` 用 `fetch(url, { cf: { cacheTtl: 300 } })` 缓存的是**对 raw.githubusercontent 的那次请求**。Worker 每次仍然要跑、要查缓存、要重新拼响应。未命中时 400ms，命中也要 110ms。

**改法**：用 Cache API 把**最终吐给浏览器的 Response** 存进边缘缓存，命中就直接返回，Worker 连 subrequest 都不用发。

```js
const EDGE = caches.default;

async function serveSiteCached(env, target, req) {
  // 静态 shell 长缓存，数据文件短缓存
  const isData = target.path.startsWith('/data/');
  const ttl = isData ? 600 : 86400;
  const key = new Request('https://edge.internal' + target.path, { method: 'GET' });

  let res = await EDGE.match(key);
  if (!res) {
    res = await serveSite(env, target);              // 你现有的逻辑
    if (res.ok) {
      const h = new Headers(res.headers);
      h.set('Cache-Control', `public, max-age=${isData ? 300 : 86400}, s-maxage=${ttl}, stale-while-revalidate=86400`);
      h.set('X-Edge', 'MISS');
      const body = await res.arrayBuffer();           // 必须读完才能 put
      res = new Response(body, { status: res.status, headers: h });
      await EDGE.put(key, res.clone());
      return res;
    }
  }
  return res;
}
```

**预期**：未命中 400ms → 首次之后稳定 **20–50ms**；`/manifest.json` 那类小文件从 418ms 掉到 30ms 以内。

### P0-2 静态资源给长缓存 + 内容指纹

| 文件 | 现在 | 改成 |
|---|---|---|
| `js/bundle.js` | `max-age=300` | `max-age=31536000, immutable`，文件名带 hash（`bundle.a1b2c3.js`） |
| `js/md.js` | `max-age=300` | 同上 |
| `icon.svg` / `manifest.json` | `max-age=300` | `max-age=604800` |
| `data/repos.js` | `max-age=300` | `max-age=900, stale-while-revalidate=3600`（数据 3 小时一更，5 分钟太紧） |

**预期**：回访用户首屏少下 23KB，且不再有 5 分钟一次的全量重下。**顺带补 `ETag`**（`generatedAt` 正好当版本号），让浏览器能 304。

### P0-3 拆 `data/repos.js`：403KB → 约 100KB

这是首屏 93% 的流量。现在四个时间范围全部塞进一个文件，页面只用一个。

**改法**（`scripts/fetch.js` 的 `toJs`）：

```js
// 现在：一个文件装 week/month/year/all
// 改成：每个 range 一个文件 + 一个轻量索引
write('data/repos-index.js',  `window.__GHRANK_META__=${JSON.stringify({generatedAt})}`)
write('data/repos-week.js',   `window.__GHRANK_RANGE__=${JSON.stringify(RANGES.week)}`)
write('data/repos-month.js',  ...)
write('data/repos-year.js',   ...)
write('data/repos-all.js',    ...)
```

前端 `js/bundle.js` 的 `load()` 改成按当前 `range` 动态 `import()` / 插 `<script>`，切换范围时才拉另一个。

**预期**：首屏数据从 403KB 降到约 **90–130KB**（week 段最小），加载时间 1.25s → 0.35s。这是纯前端收益，和 CDN 无关，弱网用户体感最明显。

### P1-1 数据搬进 Workers KV / R2，彻底告别回源

`raw.githubusercontent.com` 在美国，而且国内时通时不通。让 GitHub Action 抓完数据后**顺手推到 KV**（一次性 `PUT`，用 KV REST API），Worker 只读 KV：

```js
const data = await env.DATA_KV.get('repos-week');   // <10ms，全球复制
```

**收益**：一是 TTFB 再降；二是**彻底消除 raw.githubusercontent 抖动导致的偶发 404/超时**（这个站现在的单点故障就是它）。KV 免费额度 10 万读/天，够用。

### P1-2 Early Hints 抢 100–200ms

HTML 出得比 `repos.js` 早，可以在响应头里先告诉浏览器去拉：

```js
// Workers 支持 103
const early = new Response(null, { status: 103, headers: {
  'Link': '</js/bundle.js>; rel=preload; as=script, </data/repos-week.js>; rel=preload; as=script'
}});
```

配合 `<link rel="preload">`，可省掉"解析 HTML 完才发现要下 400KB"的那段空转。

### P1-3 `HEAD` 请求现在返回 404

`worker.js:36` 只放了 `request.method === 'GET'`：

```js
// 现在
if (request.method === 'GET' && SITE[url.pathname]) {
// 改成
if ((request.method === 'GET' || request.method === 'HEAD') && SITE[url.pathname]) {
```

实测：`HEAD /` → 404、`HEAD /js/bundle.js` → 404（`/robots.txt` 是 200，因为走的是另一条分支）。**很多监控探针、链接预检、社交平台抓取用 HEAD**，现在全被判成死链。

### P1-4 `/api/status` 996ms

串行调 GitHub API 两次（workflow 状态 + 仓库信息）。两个请求 `Promise.all` 并行，外加 60 秒边缘缓存，能压到 200ms 内。

### P2 小项

| 项 | 说明 |
|---|---|
| `sw.js` 预取 `data/repos.js` | 装 SW 时就把 400KB 下下来，弱网用户第一次访问白白多 400KB。改成不预取，或只在 `navigator.connection.saveData === false` 时预取 |
| `canonical` 还指着 workers.dev | 实测 `github.661026.xyz` 返回的 `<link rel="canonical">` 和 `data/site.json` 的 `siteUrl` 都还是 `https://github-rank.xiaoh2018.workers.dev`。**新域名上线后这两个必须改**，否则搜索引擎把权重全算到旧域名，新域名白干 |
| `og:image` 空 | 分享到微信/Twitter 没图 |
| 大文件走 gzip | `repos.js` 的 br 比 gzip 大 2%，虽然客户端协商你控制不了，但把大文件拆小后 br 的表现会变好（小文件 br 通常更优） |

---

## 4. 不用折腾的清单（省点时间）

| 别动 | 原因 |
|---|---|
| HTTP/2、HTTP/3、TLS 1.3 | 已经全开，实测 `alpn=h2`、`TLSv1.3`、`alt-svc h3` 都在 |
| Brotli 开关 | CF 自动协商，实测反而 gzip 更小，你改不了也不值得改 |
| Argo Smart Routing | 对 Worker 直出响应基本无效（没有长链路回源可优化） |
| Smart Placement | 它是把 Worker 挪到**离源站近**的地方（会挪去美国），对国内用户是**负优化**，别开 |
| 换 CDN 厂商 | 免费版里 CF 的 anycast + 中国周边节点已经是最优解之一，换谁都一样受国际出口限制 |
| 内联 CSS 那 13KB | gzip 后 12KB，省下的钱不够折腾的 |

---

## 5. 一页总结

```
现在：431KB 首屏，TTFB 冷 400ms / 热 110ms，优选域名无效
瓶颈：① 每个未命中文件回源美国 300ms  ② repos.js 独占 403KB  ③ 全站 5 分钟缓存
先做：P0-1 缓存成品响应  → TTFB 稳定 20–50ms
      P0-3 拆数据文件    → 首屏 431KB → 约 130KB
      P0-2 长缓存+指纹   → 回访用户几乎零下载
再做：P1-1 上 KV         → 干掉 raw.githubusercontent 这个单点
      P1-3 修 HEAD 404   → 监控/预检不再误判死链
优选：CNAME 到 182682 是无效的（解析结果完全同一组 IP）；要优选就写 A 记录填测出来的 IP
天花板：免费版没有 CN 专线，HKG 已经不错了；要真加速只有企业版中国网络
```
---

## 附：本报告的落地进度（2026-11-24 傍晚）

- ✅ P0-1 边缘缓存、✅ P0-2 长缓存+ETag、✅ P0-3 数据按 range 拆分、✅ P1-3 修 HEAD —— 代码已改并本地模拟 workers 运行时验证通过，细节与实测见 [优化建议.md](优化建议.md) §7。
- ⏳ P1-1 数据搬 KV、P1-2 Early Hints、P1-4 `/api/status` 未做（理由见优化建议 §7 末尾）。
- ⚠️ 以上改动全部在 `worker.js` 里，**必须在 Cloudflare 重新粘贴部署 Worker 才生效**；数据拆分还需要等一次 Action 跑完。
- DNS 现状补充：`github.661026.xyz` 是灰色（DNS only）CNAME 到 `github.cloudflare.182682.xyz`，CF 回源时按 SNI 认 zone，因此线上可用；但实测解析出的 5 个 IP 与自建无关域名完全相同（172.66.143.239 / 172.66.215.173 / 172.67.205.252 / 104.25.246.254 / 104.25.253.202），说明并没有换到更快的一组边缘节点——**零收益，且可用性挂在别人的 DNS 记录上**（对方删掉这条记录，你的站立刻解析失败）。真正要快只有两条：自己 zone 里加 A 记录指向实测更快的 CF IP，或上 Cloudflare for SaaS 自定义主机名。
