// 后台「旧地址 N 个（已 301）」提示门禁：改链接后 prevCount 增加、公开接口带字段、后台有这段文案。
// 用法：先起 dev-server（8123），再 node scripts/check-prev-count.mjs
const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const TAG = '__pc__';
const TITLE = TAG + '旧地址计数测试';

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

const post = async (body) => {
  const r = await fetch(base + '/api/articles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
};
const mine = async () => {
  const j = await (await fetch(base + '/api/articles')).json().catch(() => null);
  const arr = Array.isArray(j) ? j : ((j && j.articles) || []);
  return arr.filter((a) => String(a.title || '') === TITLE).pop() || null;
};

let id = '';
const cleanup = async () => {
  if (id) await post({ password: PW, action: 'remove', id });
  const arr = await (await fetch(base + '/data/articles.json')).json().catch(() => null);
  const list = Array.isArray(arr) ? arr : ((arr && arr.articles) || []);
  console.log('清理后剩余 ' + list.length + ' 篇，残留 ' + list.filter((a) => String(a.title || '').indexOf(TAG) === 0).length + ' 篇');
};

try {
  const add = await post({ password: PW, action: 'add', article: { title: TITLE, summary: '旧地址计数', body: '正文', category: '技术', date: '2026-11-26' } });
  const a1 = (Array.isArray(add.articles) ? add.articles : []).filter((a) => String(a.title || '') === TITLE).pop();
  id = a1 && a1.id ? String(a1.id) : '';
  ok('新建文章成功', !!id, JSON.stringify(add).slice(0, 120));
  ok('新文章 prevCount 是 0', !!a1 && a1.prevCount === 0, a1 && a1.prevCount);

  await post({ password: PW, action: 'update', id, article: { title: TITLE, summary: '旧地址计数', body: '正文', category: '技术', date: '2026-11-26', slug: 'pc/8' } });
  const m1 = await mine();
  ok('改一次链接后 prevCount 变 1', !!m1 && m1.prevCount === 1, m1 && m1.prevCount);

  await post({ password: PW, action: 'update', id, article: { title: TITLE, summary: '旧地址计数', body: '正文', category: '技术', date: '2026-11-26', slug: 'pc/9' } });
  const m2 = await mine();
  ok('再改一次后 prevCount 变 2', !!m2 && m2.prevCount === 2, m2 && m2.prevCount);
  ok('公开数据仍不暴露具体旧地址', !!m2 && !('prevSlugs' in m2), m2 && Object.keys(m2).join(','));

  const adm = await (await fetch(base + '/admin')).text();
  ok('后台脚本用到 prevCount', adm.indexOf('a.prevCount') > -1, '');
  ok('后台有「旧地址 … 个（已 301）」文案', adm.indexOf("旧地址 ' + a.prevCount + ' 个（已 301）") > -1, '');
} finally {
  await cleanup();
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
