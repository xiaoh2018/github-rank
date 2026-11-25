// 文章改链接（分类/序号）后旧地址 301 门禁：
// 旧地址能打开 → 改链接 → 旧地址 301 到新地址、新地址 200、历史旧地址继续 301、
// 公开数据不暴露 prevSlugs、批量改分类也连带改链接并 301、删文章后 404。
// 用法：先起 dev-server（8123），再 node scripts/check-slug-alias.mjs
const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const TAG = '__alias__';
const TITLE = TAG + '旧地址 301 测试';
const TA = TAG + '批量 A';
const TB = TAG + '批量 B';

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

const post = async (body) => {
  const r = await fetch(base + '/api/articles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
};
const getArt = async (p) => {
  const r = await fetch(base + p, { redirect: 'manual' });
  return { status: r.status, loc: r.headers.get('location') || '', text: await r.text() };
};
const pubList = async () => {
  const j = await (await fetch(base + '/data/articles.json')).json().catch(() => null);
  return Array.isArray(j) ? j : ((j && j.articles) || []);
};
const pick = (j, title) => {
  const arr = Array.isArray(j && j.articles) ? j.articles : [];
  return arr.filter((a) => String(a.title || '') === title).pop() || null;
};

const ids = [];
const cleanup = async () => {
  for (const id of ids) await post({ password: PW, action: 'remove', id });
  const arr = await pubList();
  console.log('清理后剩余文章 ' + arr.length + ' 篇，残留测试文章 ' + arr.filter((a) => String(a.title || '').indexOf(TAG) === 0).length + ' 篇');
};

try {
  // 1) 建一篇（分类「技术」→ 链接 tech/N）
  const add = await post({ password: PW, action: 'add', article: { title: TITLE, summary: '改链接后旧地址要 301', body: '正文内容，用来确认页面能打开。', category: '技术', date: '2026-11-26' } });
  const a1 = pick(add, TITLE);
  if (a1 && a1.id) ids.push(String(a1.id));
  const id = a1 ? String(a1.id) : '';
  ok('新建文章成功', !!id, JSON.stringify(add).slice(0, 140));
  const slug1 = a1 && a1.slug ? a1.slug : '';
  ok('新文章拿到「分类词/序号」链接', /^[a-z0-9-]+\/\d+$/.test(slug1), slug1);
  const path1 = '/articles/' + slug1 + '.html';
  const p1 = await getArt(path1);
  ok('改之前旧地址能打开（200）', p1.status === 200, p1.status);
  ok('页面标题是本篇', p1.text.indexOf(TAG) > -1, '');

  // 2) 改链接到 alias/9
  await post({ password: PW, action: 'update', id, article: { title: TITLE, summary: '改链接后旧地址要 301', body: '正文内容，用来确认页面能打开。', category: '技术', date: '2026-11-26', slug: 'alias/9' } });
  const old1 = await getArt(path1);
  ok('旧地址变 301', old1.status === 301, old1.status);
  ok('301 指向新地址', old1.loc.indexOf('/articles/alias/9.html') > -1, old1.loc);
  const neu = await getArt('/articles/alias/9.html');
  ok('新地址 200', neu.status === 200, neu.status);
  ok('新地址标题正确', neu.text.indexOf(TAG) > -1, '');

  // 3) 再改一次：两个旧地址都 301 到最新地址
  await post({ password: PW, action: 'update', id, article: { title: TITLE, summary: '改链接后旧地址要 301', body: '正文内容，用来确认页面能打开。', category: '技术', date: '2026-11-26', slug: 'alias/10' } });
  const old2 = await getArt('/articles/alias/9.html');
  ok('中间那个旧地址也 301', old2.status === 301 && old2.loc.indexOf('/articles/alias/10.html') > -1, old2.status + ' ' + old2.loc);
  const old3 = await getArt(path1);
  ok('最早的旧地址继续 301（历史保留）', old3.status === 301 && old3.loc.indexOf('/articles/alias/10.html') > -1, old3.status + ' ' + old3.loc);

  // 4) 公开投影不暴露 prevSlugs
  const arr1 = await pubList();
  const mine = arr1.filter((a) => String(a.title || '') === TITLE).pop();
  ok('/data/articles.json 里有这篇文章', !!mine, '');
  ok('公开数据不暴露 prevSlugs', !!mine && !('prevSlugs' in mine), mine && Object.keys(mine).join(','));

  // 5) 批量改分类：链接跟着分类走，旧地址 301
  const bA = await post({ password: PW, action: 'add', article: { title: TA, summary: '批量改分类', body: '批量 A 正文', category: '随笔', date: '2026-11-26' } });
  const bB = await post({ password: PW, action: 'add', article: { title: TB, summary: '批量改分类', body: '批量 B 正文', category: '随笔', date: '2026-11-26' } });
  const rA = pick(bA, TA);
  const rB = pick(bB, TB);
  if (rA && rA.id) ids.push(String(rA.id));
  if (rB && rB.id) ids.push(String(rB.id));
  ok('批量测试的两篇都建好', !!(rA && rB), '');
  const beforeA = rA && rA.slug ? rA.slug : '';
  const bulk = await post({ password: PW, action: 'bulk', op: 'category', category: '技术', ids: [rA && rA.id, rB && rB.id].filter(Boolean) });
  ok('批量改分类返回 changed=2', bulk && bulk.changed === 2, JSON.stringify(bulk).slice(0, 120));
  const afterA = (bulk && Array.isArray(bulk.articles) ? bulk.articles : []).filter((a) => String(a.title || '') === TA).pop();
  ok('分类改完后链接的分类词也变了', !!(afterA && afterA.slug && beforeA && afterA.slug.indexOf('tech/') === 0), (beforeA + ' → ' + (afterA && afterA.slug)));
  const bOld = await getArt('/articles/' + beforeA + '.html');
  ok('批量改分类后旧地址 301 到新地址', bOld.status === 301 && bOld.loc.indexOf('/articles/' + (afterA && afterA.slug) + '.html') > -1, bOld.status + ' ' + bOld.loc);

  // 6) 删掉后 404（不再错误地 301 到别处）
  for (const id2 of ids.slice()) {
    await post({ password: PW, action: 'remove', id: id2 });
    const i2 = ids.indexOf(id2);
    if (i2 > -1) ids.splice(i2, 1);
  }
  const gone = await getArt('/articles/alias/10.html');
  ok('删掉后新地址 404', gone.status === 404, gone.status);
  const gone2 = await getArt(path1);
  ok('删掉后旧地址 404（不是 301）', gone2.status === 404, gone2.status);
} finally {
  await cleanup();
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
