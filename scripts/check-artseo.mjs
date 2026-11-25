// 单篇文章页的按篇 SEO 全链路验证（跑在 dev-server 上，写入会真的落到 data/articles.json）
// 用法：先 node scripts/dev-server.mjs，再 node scripts/check-artseo.mjs
const base = process.env.ARTSEO_BASE || 'http://127.0.0.1:8123';
const pw = process.env.DEV_PW || 'dev';
const t = Date.now();

let fail = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log('  PASS  ' + label);
  else {
    fail++;
    console.log('  FAIL  ' + label + (detail ? '  →  ' + detail : ''));
  }
};

const js = { 'content-type': 'application/json' };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: js, body: JSON.stringify(Object.assign({ password: pw }, body)) });
  return { r, j: await r.json().catch(() => ({})) };
};

const page = async (p) => {
  const r = await fetch(base + p + (p.includes('?') ? '&' : '?') + 'v=' + t);
  return { r, html: await r.text() };
};

const path = (slug) => '/articles/' + String(slug).split('/').map(encodeURIComponent).join('/') + '.html';

console.log('== 1. 普通文章：标题/描述/canonical/JSON-LD ==');
const add = await post('/api/articles', { action: 'add', article: { title: 'SEO 链路测试', summary: '这是链路测试摘要', body: '正文内容不该出现在 head 里 XYZ', category: '技术' } });
const made = (add.j.articles || []).filter((a) => a.title === 'SEO 链路测试').pop();
ok(!!made, '建测试文章', made ? made.slug : JSON.stringify(add.j.error || ''));

let madeLocked = null;
try {
  if (made) {
    const p = path(made.slug);
    const { r, html } = await page(p);
    ok(r.status === 200, '文章页 200', String(r.status));
    ok(html.indexOf('<title>SEO 链路测试 · ') >= 0, '标题按文章注入', (html.match(/<title>[\s\S]*?<\/title>/i) || [''])[0]);
    ok(html.indexOf('content="这是链路测试摘要"') >= 0, '描述取摘要', '');
    ok(html.indexOf('rel="canonical"') >= 0 && html.indexOf(p + '"') >= 0, 'canonical 指向本篇', '');
    ok(html.indexOf('property="og:type" content="article"') >= 0, 'og:type=article', '');
    ok(html.indexOf('"@type":"BlogPosting"') >= 0, '注入 BlogPosting', '');
    ok(html.indexOf('"headline":"SEO 链路测试"') >= 0, 'JSON-LD 带标题', '');
    ok(html.indexOf('noindex') < 0, '普通文章可被索引', '');
    ok(html.indexOf('正文内容不该出现在 head 里') < 0, '正文不进 head', '');
    const again = await fetch(base + p + '?v=' + t);
    ok(again.headers.get('x-edge') === 'HIT', '第二次命中边缘缓存', String(again.headers.get('x-edge')));
  }

  console.log('== 2. 加密文章：noindex + 只给摘要 ==');
  const addL = await post('/api/articles', { action: 'add', article: { title: '加密SEO链路', summary: '加密摘要ABC', body: '机密正文XYZ789', category: '技术', locked: true, password: 'gate-pw-9' } });
  madeLocked = (addL.j.articles || []).filter((a) => a.title === '加密SEO链路').pop();
  ok(!!madeLocked, '建加密测试文章', madeLocked ? madeLocked.slug : '');
  if (madeLocked) {
    const { r, html } = await page(path(madeLocked.slug));
    ok(r.status === 200, '加密文章页 200', String(r.status));
    ok(html.indexOf('noindex,follow') >= 0, '加密文章 noindex', '');
    ok(html.indexOf('content="加密摘要ABC"') >= 0, '仍给摘要（分享卡片不至于空白）', '');
    ok(html.indexOf('机密正文XYZ789') < 0, '正文不下发', '');
  }

  console.log('== 3. 不存在的文章地址 ==');
  const miss = await page('/articles/nosuch/999.html');
  ok(miss.r.status === 404, '不存在的文章 404', String(miss.r.status));
  ok(miss.html.indexOf('这个页面不存在') >= 0, '给 404 页而不是空壳', '');
} finally {
  for (const a of [made, madeLocked]) {
    if (!a) continue;
    await post('/api/articles', { action: 'remove', id: a.id });
  }
  const list = await (await fetch(base + '/data/articles.json?v=' + Date.now())).json();
  const arr = Array.isArray(list) ? list : list.articles || [];
  ok(arr.filter((x) => String(x.title || '').indexOf('SEO 链路测试') >= 0 || String(x.title || '').indexOf('加密SEO链路') >= 0).length === 0, '测试文章已清理', '剩 ' + arr.length + ' 篇');
}

console.log(fail === 0 ? '文章页 SEO 全部通过' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
