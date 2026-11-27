// 本地预览服务：把 worker.js 跑在 Node 里，读本地文件当「GitHub 仓库」，方便改完先在本机看效果
// 用法：node scripts/dev-server.mjs [端口]   （默认 8123）
// 打开 http://127.0.0.1:8123/ 看站点，http://127.0.0.1:8123/admin 看后台（密码 dev）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SAMPLE_README = "# build-your-own-x\n\n<p align=\"center\">\n  <img src=\"https://img.shields.io/badge/stars-565k-gold\" alt=\"stars\">\n  <img src=\"https://img.shields.io/badge/license-MIT-blue\" alt=\"license\">\n</p>\n\n从零开始重构你喜爱的技术，从而掌握编程。**只保留可以动手的部分**，每个项目都能在周末跑通。\n\n## 目录\n\n| 方向 | 代表项目 | 语言 |\n| :--- | :---: | ---: |\n| 数据库 | build-your-own-redis | C |\n| 容器 | build-your-own-docker | Go |\n| 编译器 | build-your-own-lisp | C++ |\n\n## 快速开始\n\n1. 选一个方向\n2. 克隆仓库并跑通示例\n3. 在 `notes/` 里写总结\n\n- [x] 先读 README\n- [ ] 再动手写代码\n\n```bash\ngit clone https://github.com/example/redis-clone\ncd redis-clone && make\n```\n\n> 提示：把 `make` 的输出贴进 issue，方便别人帮你排查。\n\n更多内容见 [官方教程](https://example.com/tutorial) 与 [Wiki](https://example.com/wiki)。";

const realFetch = globalThis.fetch;
const root = path.resolve(process.cwd());
const port = Number(process.argv[2] || 8123);
const PASSWORD = 'dev';

const copy = path.join(os.tmpdir(), 'ghrank-dev-' + Date.now() + '.mjs');
fs.writeFileSync(copy, fs.readFileSync(path.join(root, 'worker.js'), 'utf8'));

const store = new Map();
// 真 Cloudflare 的 caches.default 允许传字符串或 Request，并会把它规范成绝对 URL。
// 这里以前只取 req.url，worker 传字符串时得到 undefined —— 所有缓存撞在同一个键上，
// 表现是「随便打开哪篇文章都返回第一次打开的那篇」。必须规范化。
const ck = (req) => {
  try {
    if (typeof req === 'string') return new URL(req, 'https://edge.ghrank.internal').toString();
    if (req && typeof req.url === 'string' && req.url) return new URL(req.url, 'https://edge.ghrank.internal').toString();
  } catch (e) {
    /* 落到下面的兜底 */
  }
  return String(req);
};
globalThis.caches = {
  default: {
    async match(req) {
      const k = ck(req);
      const v = store.get(k);
      if (!v) return undefined;
      // 假缓存必须遵守 TTL：真 caches.default 会按 s-maxage 过期，这里以前永不过期，
      // 于是「门禁写过、又还原」之后，缓存里那版内容会一直活着（第 9 轮遇到的幽灵）。
      if (v.exp && v.exp < Date.now()) { store.delete(k); return undefined; }
      return new Response(v.body, { status: v.status, headers: v.headers });
    },
    async put(req, res) {
      const cc = res.headers.get('cache-control') || '';
      const m = /(?:s-maxage|max-age)=(\d+)/i.exec(cc);
      const ttl = m ? Number(m[1]) * 1000 : 0;
      const key = ck(req);
      const body = Buffer.from(await res.clone().arrayBuffer());
      store.set(key, {
        body: body,
        status: res.status,
        headers: [...res.headers],
        exp: ttl > 0 ? Date.now() + ttl : 0,
      });
    },
    async delete(req) {
      const k = ck(req);
      store.delete(k);
      // 兜底：worker 里同一路径可能以 ?v=<版本> 缓存（版本化资源），只按精确键删会留幽灵。
      // 开发环境按路径清一遍，省得排查半天（生产没有这一层，Cloudflare 自己按 URL 处理）。
      let p = "";
      try { p = new URL(k).pathname; } catch (e) { p = ""; }
      if (p) {
        for (const key of [...store.keys()]) {
          if (key.indexOf(p) >= 0) store.delete(key);
        }
      }
    },
  },
};

const jsonResp = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
const local = (rel) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};
// 保存类请求把内容写回本地文件，这样本地点「保存」也能看到效果
const writeLocal = (rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
};

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init && init.method) || 'GET';
  // 访问自己（key 文件自检、/api/* 内部调用）时直接转发给本地服务，避免 502
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
    try { return await realFetch(url, init); } catch (e) { return new Response('dev fetch failed: ' + e.message, { status: 502 }); }
  }
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    const rel = decodeURIComponent((url.split('/main/')[1] || '').split('?')[0]); // worker 现在会给 raw 加 ?v=
    const buf = local(rel);
    return buf ? new Response(buf) : new Response('not found', { status: 404 });
  }
  if (url.startsWith('https://api.github.com/')) {
    if (/\/repos\/[^/]+\/[^/]+\/readme/.test(url)) {
      return new Response(SAMPLE_README, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (/\/repos\/[^/]+\/[^/]+\/releases\/latest/.test(url)) {
      return jsonResp({ tag_name: 'v1.2.3', html_url: 'https://github.com/example/repo/releases/tag/v1.2.3', published_at: '2026-11-01T12:00:00Z' });
    }
    if (/\/repos\/[^/]+\/[^/]+\/contributors/.test(url)) {
      return jsonResp([
        { login: 'octocat', html_url: 'https://github.com/octocat', avatar_url: 'https://avatars.githubusercontent.com/u/583231?s=64', contributions: 128 },
        { login: 'torvalds', html_url: 'https://github.com/torvalds', avatar_url: 'https://avatars.githubusercontent.com/u/1024025?s=64', contributions: 42 }
      ]);
    }
    if (/\/repos\/[^/]+\/[^/]+\/commits/.test(url)) {
      return jsonResp([{ commit: { committer: { date: new Date(Date.now() - 2 * 86400000).toISOString() } } }]);
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return jsonResp({
        full_name: 'example/repo',
        html_url: 'https://github.com/example/repo',
        description: '本地预览用的假仓库',
        stargazers_count: Number(url.length) + 1000,
        forks_count: 512,
        open_issues_count: 23,
        subscribers_count: 88,
        pushed_at: new Date(Date.now() - 3600000).toISOString(),
        created_at: '2018-05-09T00:00:00Z',
        license: { spdx_id: 'MIT' }
      });
    }
    if (url.includes('/contents/')) {
      const rel = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
      if (method === 'PUT') {
        const body = JSON.parse((init && init.body) || '{}');
        writeLocal(rel, Buffer.from(body.content || '', 'base64').toString('utf8'));
        return jsonResp({ content: { sha: 'dev-' + Date.now() }, commit: { sha: 'dev' } });
      }
      const buf = local(rel) || Buffer.from('');
      return jsonResp({ sha: 'dev-' + rel.replace(/\W/g, ''), content: buf.toString('base64') });
    }
    if (url.includes('/git/trees/')) return jsonResp({ tree: [] });
    if (url.includes('/commits')) return jsonResp([{ commit: { committer: { date: new Date(Date.now() - 2 * 86400000).toISOString() } } }]);
    if (url.includes('/actions/workflows')) {
      return jsonResp({ workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: new Date(Date.now() - 3600000).toISOString() }] });
    }
    return jsonResp({});
  }
  // MyMemory 之类的外部服务本地直接失败，走兜底分支
  return new Response('', { status: 502 });
};

const mod = await import('file://' + copy.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':'));
const env = {
  GITHUB_TOKEN: 'dev-token',
  REPO_OWNER: 'xiaoh2018',
  REPO_NAME: 'github-rank',
  ADMIN_PASSWORD: PASSWORD,
};
const ctx = { waitUntil() {} };

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = 'http://127.0.0.1:' + port + req.url;
    // 仅本地测试用：清掉进程内的假边缘缓存。门禁脚本会改数据再还原，
    // 不清缓存的话后续门禁会读到"测试数据"（nav 只剩 1 条之类）。
    if ((new URL(url).pathname) === '/__purge') {
      store.clear();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, purged: true }));
      return;
    }
    // data-json-bypass：本地 /data/*.json 直接读磁盘，不经过假边缘缓存。
    // 否则门禁「写完再还原」之后，缓存里还留着测试数据 —— 截图和本地核对会看到幽灵内容。
    {
      const pn = new URL(url).pathname;
      if (/^\/data\/articles\.json$/.test(pn)) {
        const bufA = local('data/articles.json');
        if (bufA) {
          let arr = [];
          try { arr = JSON.parse(bufA.toString('utf8')); } catch (e) { arr = []; }
          const proj = (Array.isArray(arr) ? arr : []).map((a) => {
            const o = {};
            for (const k of Object.keys(a || {})) {
              if (k === 'lock' || k === 'prevSlugs') continue;
              o[k] = a[k];
            }
            o.locked = !!a.locked;
            o.hasLock = !!(a.lock && a.lock.ct);
            o.prevCount = Array.isArray(a.prevSlugs) ? a.prevSlugs.length : 0;
            return o;
          });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(proj));
          return;
        }
      }
      if (/^\/data\/[A-Za-z0-9._-]+\.json$/.test(pn)) {
        const buf = local(pn.replace(/^\/+/, ''));
        if (buf) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(buf);
          return;
        }
      }
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    let out;
    try {
      out = await mod.default.fetch(new Request(url, { method: req.method, headers, body }), env, ctx);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dev-server 500: ' + (e && e.message));
      return;
    }
    // 本地调试用：worker 不认识的路径，如果仓库里真有这个文件就直接发（方便放临时探针页）
    if (out.status === 404) {
      const rel = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
      const buf = rel && !rel.includes('..') ? local(rel) : null;
      if (buf) {
        res.writeHead(200, { 'content-type': rel.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
        res.end(buf);
        return;
      }
    }
    const buf = Buffer.from(await out.arrayBuffer());
    const h = {};
    out.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(out.status, h);
    res.end(buf);
  })
  .listen(port, '127.0.0.1', () => {
    console.log('本地预览：http://127.0.0.1:' + port + '/    后台：http://127.0.0.1:' + port + '/admin（密码 ' + PASSWORD + '）');
    // 本地 data/ 常年落后于 Action 的提交（rest-push 只推我改过的文件），旧数据会骗截图、骗本地门禁
    try {
      const metaPath = path.join(root, 'data', 'repos-meta.js');
      const txt = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '';
      const gen = (txt.match(/generatedAt:\s*"([^"]+)"/) || [])[1] || '';
      const ageH = gen ? (Date.now() - Date.parse(gen)) / 3600000 : NaN;
      if (Number.isFinite(ageH) && ageH > 6) {
        console.log('⚠ 本地数据是 ' + ageH.toFixed(1) + ' 小时前的（' + gen + '）：截图与本地核对都会被它骗。先跑 node scripts/sync-data.mjs');
      } else if (gen) {
        console.log('数据：' + gen + '（' + ageH.toFixed(1) + ' 小时前）');
      }
    } catch (e) { console.log('数据新鲜度自检跳过：' + e.message); }
  });
