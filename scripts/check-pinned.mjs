// 置顶功能的端到端门禁：写入 → 公开投影 → 改回 → 删除
// 需要先起 dev-server（默认 8123）。写入真落盘，结束时清理。
// 注意：/api/articles 的 add/update 要把字段放在 body.article 里。
const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const T = '__gate__置顶测试';
let fails = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']'));
  if (!cond) fails++;
};

const post = async (body) => {
  const r = await fetch(base + '/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ password: PW }, body)),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
};
const arts = async () => {
  const r = await fetch(base + '/data/articles.json?v=' + Date.now());
  const t = await r.text();
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : (j.articles || []); } catch (e) { return []; }
};

const cleanup = async () => {
  const list = await arts();
  for (const a of list.filter((x) => x && x.title === T)) await post({ action: 'remove', id: a.id });
};

await cleanup();

console.log('== 1. 新建带置顶的文章 ==');
const add = await post({ action: 'add', article: { title: T, category: '技术', body: '置顶门禁用正文', pinned: true } });
ok('新建 200', add.status === 200, add.status + ' ' + JSON.stringify(add.json).slice(0, 160));
let list = await arts();
let one = list.filter((a) => a && a.title === T)[0];
ok('公开投影里有这篇', !!one, '共 ' + list.length + ' 篇');
ok('pinned 落盘为 true', !!one && one.pinned === true, one && JSON.stringify(one.pinned));
ok('没把 lock 键发出去', !(one && 'lock' in one), one && Object.keys(one).join(','));

if (one) {
  console.log('== 2. 非布尔值不放行 ==');
  const upd = await post({ action: 'update', id: one.id, article: { title: T, category: '技术', body: '置顶门禁用正文', pinned: 'yes' } });
  ok('update 200', upd.status === 200, upd.status);
  list = await arts();
  one = list.filter((a) => a && a.title === T)[0];
  ok('字符串 yes 被当成 false', !!one && one.pinned === false, one && JSON.stringify(one.pinned));
}

console.log('== 3. 置顶排序与徽标代码在位 ==');
const fs = await import('node:fs');
const idx = fs.readFileSync('index.html', 'utf8');
const art = fs.readFileSync('articles.html', 'utf8');
const adm = fs.readFileSync('worker.js', 'utf8');
ok('首页按 pinned 优先排序', idx.includes('a.pinned?-1:1'), '');
ok('首页有置顶徽标', idx.includes("className='pinchip'"), '');
ok('文章页按 pinned 优先排序', art.includes('a.pinned ? -1 : 1'), '');
ok('文章页有置顶徽标', art.includes('class="pinchip"'), '');
ok('后台有置顶勾选', adm.includes('id="artPinned"'), '');
ok('后台提交带 pinned', adm.includes('pinned: $(\'artPinned\')'), '');

console.log('== 4. 清理 ==');
await cleanup();
list = await arts();
ok('测试文章已删除', !list.some((a) => a && a.title === T), '剩 ' + list.length + ' 篇');

console.log(fails ? `置顶门禁 ${fails} 项失败` : '置顶门禁全部通过');
process.exit(fails ? 1 : 0);
