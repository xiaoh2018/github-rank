// 验证脚本：模拟 Workers 运行时（caches + fetch 打桩读本地文件 / 假 GitHub API），检查本轮改动
// 用法：node scripts/check-worker.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(process.cwd());
const src = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
const copy = path.join(os.tmpdir(), 'ghrank-worker-check-' + Date.now() + '.mjs');
fs.writeFileSync(copy, src);

const store = new Map();
const cache = {
  async match(req) {
    const v = store.get(req.url);
    return v ? new Response(v.body, { status: v.status, headers: v.headers }) : undefined;
  },
  async put(req, res) {
    const body = Buffer.from(await res.clone().arrayBuffer());
    store.set(req.url, { body, status: res.status, headers: [...res.headers] });
  },
  async delete(req) {
    store.delete(req.url);
  },
};
globalThis.caches = { default: cache };

let rawCount = 0;
let apiCount = 0;
const jsonResp = (o) =>
  new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    rawCount++;
    const rel = decodeURIComponent(url.split('/main/')[1] || '');
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(p));
  }
  if (url.startsWith('https://api.github.com/')) {
    apiCount++;
    if (url.includes('/commits')) {
      return jsonResp([{ commit: { committer: { date: new Date(Date.now() - 2 * 86400000).toISOString() } } }]);
    }
    if (url.includes('/actions/workflows')) {
      return jsonResp({
        workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: new Date(Date.now() - 3600000).toISOString() }],
      });
    }
    return jsonResp({ sha: 'abc123', content: { sha: 'abc123' } });
  }
  throw new Error('unexpected fetch: ' + url);
};

const mod = await import('file://' + copy.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':'));
const env = {
  GITHUB_TOKEN: 'token',
  REPO_OWNER: 'xiaoh2018',
  REPO_NAME: 'github-rank',
  ADMIN_PASSWORD: 'pw',
};
const ctx = { waitUntil() {} };
const hit = (p, opt) => mod.default.fetch(new Request('https://github.661026.xyz' + p, opt || {}), env, ctx);

let fail = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log('  PASS  ' + label);
  else {
    fail++;
    console.log('  FAIL  ' + label + (detail ? '  →  ' + detail : ''));
  }
};

console.log('== 1. 首页 head 注入 ==');
let r = await hit('/');
let html = await r.text();
ok(r.status === 200, 'GET / → 200', 'status=' + r.status);
ok(html.includes('content="https://github.661026.xyz/og-image.png"'), 'og:image 指向新域名分享图');
ok(/<meta name="twitter:card" content="summary_large_image">/.test(html), 'twitter:card = summary_large_image');
ok(/<meta name="twitter:image" content="https:\/\/github\.661026\.xyz\/og-image\.png">/.test(html), 'twitter:image 已注入');
ok(html.includes('rel="canonical" href="https://github.661026.xyz/"'), 'canonical = github.661026.xyz');
ok(html.includes('property="og:url" content="https://github.661026.xyz/"'), 'og:url = github.661026.xyz');

console.log('== 2. 分享图托管 ==');
r = await hit('/og-image.png');
let pngBuf = Buffer.from(await r.arrayBuffer());
ok(r.status === 200 && pngBuf.length === fs.statSync(path.join(root, 'og-image.png')).size, 'GET /og-image.png → 200 且字节数一致', r.status + ' ' + pngBuf.length);
ok(pngBuf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', '返回的是合法 PNG（文件头 89 50 4E 47）');
ok((r.headers.get('content-type') || '').includes('image/png'), 'content-type = image/png', r.headers.get('content-type'));
ok(/max-age=604800/.test(r.headers.get('cache-control') || ''), '分享图按 shell 文件长缓存（max-age=604800）', r.headers.get('cache-control'));
ok(!!r.headers.get('etag'), '分享图带 ETag', r.headers.get('etag'));
r = await hit('/og-image.png', { method: 'HEAD' });
ok(r.status === 200 && !(await r.arrayBuffer()).byteLength, 'HEAD /og-image.png → 200 且 0 字节');

console.log('== 3. /api/status 边缘缓存 ==');
const before = apiCount;
r = await hit('/api/status');
const s1 = await r.json();
const firstCost = apiCount - before;
ok(s1.configured === true && s1.lastKeepalive, '/api/status 正常返回', JSON.stringify(s1).slice(0, 120));
ok(firstCost === 2, '首次请求打 2 次 GitHub API（并行）', 'apiCount+' + firstCost);
const mid = apiCount;
r = await hit('/api/status');
const s2 = await r.json();
ok(apiCount === mid, '第二次请求不回源（命中边缘缓存）', 'apiCount+' + (apiCount - mid));
ok(s2.lastKeepalive === s1.lastKeepalive, '两次返回内容一致');

console.log('== 4. 保活后自动清状态缓存 ==');
r = await hit('/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw' }),
});
const keep = await r.json();
ok(keep.ok === true, 'POST /api/run 保活成功', JSON.stringify(keep).slice(0, 120));
const afterKeep = apiCount;
r = await hit('/api/status');
await r.json();
ok(apiCount - afterKeep === 2, '保活后状态缓存已被 purge，重新回源', 'apiCount+' + (apiCount - afterKeep));

console.log('== 5. 文章页 canonical ==');
r = await hit('/articles');
const art = await r.text();
ok(art.includes('rel="canonical" href="https://github.661026.xyz/articles"'), 'articles canonical = github.661026.xyz/articles');

console.log('== 6. 友链数据已清空 ==');
const links = JSON.parse(fs.readFileSync(path.join(root, 'data/links.json'), 'utf8'));
ok(Array.isArray(links) && links.length === 0, 'data/links.json 是空数组', JSON.stringify(links));

console.log('== 7. 既有能力没被破坏 ==');
r = await hit('/');
const firstEdge = r.headers.get('x-edge');
ok(!!firstEdge, '首页带 x-edge 头（' + firstEdge + '）');
await hit('/');
const secondEdge = (await hit('/')).headers.get('x-edge');
ok(secondEdge === 'HIT', '二次访问命中边缘缓存', secondEdge);
r = await hit('/nope');
ok(r.status === 404, '未知路径 → 404', String(r.status));

console.log('');
console.log(fail === 0 ? '全部通过（回源 ' + rawCount + ' 次，API ' + apiCount + ' 次）' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);