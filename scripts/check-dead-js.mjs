import fs from 'node:fs';

const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const KEEP = ['bundle.js', 'md.js'];
const onDisk = fs.readdirSync('js').filter((f) => f.endsWith('.js'));
const extra = onDisk.filter((f) => !KEEP.includes(f));

push('js/ 下只剩打包产物（bundle.js / md.js）', extra.length === 0, extra.join(',') || '2 个');
push('没有旧模块残留（app/api/cache/config/state/ui）',
  !['app.js', 'api.js', 'cache.js', 'config.js', 'state.js', 'ui.js'].some((f) => onDisk.includes(f)), onDisk.join(','));
push('js/ 的 js 总体积 < 120KB',
  onDisk.reduce((n, f) => n + fs.statSync('js/' + f).size, 0) < 120 * 1024,
  Math.round(onDisk.reduce((n, f) => n + fs.statSync('js/' + f).size, 0) / 1024) + 'KB');

// 页面里引用的每个 js 都必须真的存在
const pages = ['index.html', 'articles.html', 'faq.html'];
const referenced = [];
for (const p of pages) {
  const s = fs.readFileSync(p, 'utf8');
  for (const m of s.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const src = m[1].split('?')[0].replace(/^\//, '');
    if (!src.startsWith('js/')) continue;
    referenced.push({ page: p, src });
  }
}
const broken = referenced.filter((r) => !fs.existsSync(r.src));
push('页面引用的脚本都存在（没有断链）', broken.length === 0, broken.map((b) => b.page + '→' + b.src).join(',') || referenced.length + ' 处引用');
push('页面引用了 bundle.js 与 md.js 两个打包产物',
  referenced.some((r) => r.src === 'js/bundle.js') && referenced.some((r) => r.src === 'js/md.js'), '');

// sw.js 预缓存列表只能列存在的文件
const sw = fs.readFileSync('sw.js', 'utf8');
const precache = [...sw.matchAll(/'\/([A-Za-z0-9._\/-]+\.(?:js|css|html))'/g)].map((m) => m[1]);
const missing = precache.filter((p) => !fs.existsSync(p));
push('sw.js 预缓存列表里的文件都存在', missing.length === 0, missing.join(',') || precache.join(' '));
push('sw.js 不再预缓存已删除的旧模块',
  !['js/app.js', 'js/api.js', 'js/cache.js', 'js/config.js', 'js/state.js', 'js/ui.js'].some((f) => precache.includes(f)), '');

// worker.js 里对 js 资源的引用（版本注入/预载）也要存在
const wk = fs.readFileSync('worker.js', 'utf8');
const wkRefs = [...new Set([...wk.matchAll(/'(\/?js\/[A-Za-z0-9._-]+\.js)'/g)].map((m) => m[1].replace(/^\//, '')))];
const wkBroken = wkRefs.filter((r) => !fs.existsSync(r));
push('worker.js 里引用的 js 资源都存在', wkBroken.length === 0, wkBroken.join(',') || wkRefs.join(' '));

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);