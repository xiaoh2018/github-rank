// 本地预览服务：把 worker.js 跑在 Node 里，读本地文件当「GitHub 仓库」，方便改完先在本机看效果
// 用法：node scripts/dev-server.mjs [端口]   （默认 8123）
// 打开 http://127.0.0.1:8123/ 看站点，http://127.0.0.1:8123/admin 看后台（密码 dev）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.cwd());
const port = Number(process.argv[2] || 8123);
const PASSWORD = 'dev';

const copy = path.join(os.tmpdir(), 'ghrank-dev-' + Date.now() + '.mjs');
fs.writeFileSync(copy, fs.readFileSync(path.join(root, 'worker.js'), 'utf8'));

const store = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const v = store.get(req.url);
      return v ? new Response(v.body, { status: v.status, headers: v.headers }) : undefined;
    },
    async put(req, res) {
      store.set(req.url, { body: Buffer.from(await res.clone().arrayBuffer()), status: res.status, headers: [...res.headers] });
    },
    async delete(req) {
      store.delete(req.url);
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
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    const rel = decodeURIComponent(url.split('/main/')[1] || '');
    const buf = local(rel);
    return buf ? new Response(buf) : new Response('not found', { status: 404 });
  }
  if (url.startsWith('https://api.github.com/')) {
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
  });
