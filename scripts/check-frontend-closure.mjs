// 后台每个板块「保存 → 前台生效」闭环审计（本地 dev-server）
// 跑法：先 `node scripts/dev-server.mjs`，再 `node scripts/check-frontend-closure.mjs`
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const PW = 'dev';
const FILES = ['data/site.json', 'data/links.json', 'data/articles.json', 'data/qa.json', 'data/nav.json'];
const snapshot = new Map();
for (const f of FILES) {
  if (fs.existsSync(f)) snapshot.set(f, fs.readFileSync(f));
}

let fail = 0;
const ok = (cond, msg, extra = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg + (extra ? '  → ' + extra : ''));
  if (!cond) fail++;
};

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW, ...body }) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};
const getText = async (p) => (await fetch(BASE + p)).text();

const site = JSON.parse(fs.readFileSync('data/site.json', 'utf8'));

// 1) SEO：标题 / 描述 / og
{
  const title = '闭环标题 ' + Date.now();
  const desc = '闭环描述 ' + Date.now();
  const r = await post('/api/site', { section: 'seo', value: { ...site.seo, title, description: desc } });
  const home = await getText('/');
  ok(r.status === 200, '保存 SEO 设置', 'status=' + r.status);
  ok(home.includes(title), '首页 <title> 用了新标题');
  ok(home.includes(desc), '首页 meta description 用了新描述');
  const dres = await fetch(BASE + '/data/site.json');
  const dtxt = await dres.text();
  ok(dtxt.includes(title), '保存后 /data/site.json 立刻是新值（warmEdge 预热）');
  ok(dres.headers.get('x-edge') === 'HIT', '保存后边缘缓存已预热（x-edge: HIT）', String(dres.headers.get('x-edge')));
}

// 2) 主题：data-theme
{
  const r = await post('/api/site', { section: 'theme', value: { name: 'ink', allowUser: true } });
  const home = await getText('/');
  ok(r.status === 200, '保存主题 ink', 'status=' + r.status);
  ok(/data-theme="ink"/.test(home), '首页 html 带 data-theme="ink"');
}

// 3) 布局：body data-layout / data-side / data-users
{
  const r = await post('/api/site', { section: 'layout', value: { mode: 'triple', side: 'below', users: 'double' } });
  const home = await getText('/');
  ok(r.status === 200, '保存布局三档', 'status=' + r.status);
  ok(home.includes('data-layout="triple"') && home.includes('data-side="below"') && home.includes('data-users="double"'), '首页 body 三属性都写上了');
}

// 4) 广告位：开启 home-top 自定义 HTML
{
  const mark = 'ADCLOSURE-' + Date.now();
  const slots = JSON.parse(JSON.stringify((site.ad && site.ad.slots) || {}));
  slots['home-top'] = { enabled: true, html: '<div>' + mark + '</div>', every: undefined, link: '', modal: '' };
  const r = await post('/api/site', { section: 'ad', value: { slots } });
  const data = await (await fetch(BASE + '/data/site.json')).text();
  ok(r.status === 200, '保存广告位 home-top', 'status=' + r.status);
  ok(data.includes(mark), '/data/site.json 里出现广告标记（前台 fetch 的就是它）');
}

// 5) 联系方式
{
  const mail = 'closure' + Date.now() + '@example.com';
  const r = await post('/api/site', { section: 'contact', value: { enabled: true, title: '闭环联系', wechat: 'wx-closure', qrUrl: '', email: mail, note: 'note' } });
  const data = await (await fetch(BASE + '/data/site.json')).text();
  ok(r.status === 200, '保存联系方式', 'status=' + r.status);
  ok(data.includes(mail), 'contact.email 回读一致');
}

// 6) 备案
{
  const r = await post('/api/site', { section: 'beian', value: { enabled: true, icp: '闭环ICP-1', icpUrl: 'https://beian.miit.gov.cn/', police: '', policeUrl: '', text: '' } });
  const data = await (await fetch(BASE + '/data/site.json')).text();
  ok(r.status === 200 && data.includes('闭环ICP-1'), '保存备案并回读');
}

// 7) 运行时（密钥/额度）—— 只验证能存能读，不触发外部请求
{
  const r = await post('/api/site', { section: 'runtime', value: { aiCap: 321, emails: 'closure@example.com', baiduToken: 'closure-token-1', indexNowKey: (site.runtime && site.runtime.indexNowKey) || '' } });
  const data = await (await fetch(BASE + '/data/site.json')).text();
  ok(r.status === 200 && data.includes('"aiCap": 321'), 'runtime.aiCap 回读一致');
  ok(data.includes('closure-token-1'), 'runtime.baiduToken 回读一致');
}

// 8) 友链（走 /api/links，接口是 add / remove，不是整表替换）
{
  const name = '闭环友链 ' + Date.now();
  const url = 'https://example.com/closure-' + Date.now() + '/';
  const r = await post('/api/links', { action: 'add', name, url, desc: 'closure' });
  const data = await (await fetch(BASE + '/data/links.json')).text();
  ok(r.status === 200, '保存友链', 'status=' + r.status);
  ok(data.includes(name), '/data/links.json 里出现新友链（首页 fetch 它渲染）');
  const list = await (await fetch(BASE + '/api/links')).json();
  const idx = (list.links || []).findIndex((l) => l && l.name === name);
  const d = await post('/api/links', { action: 'remove', index: idx });
  ok(d.status === 200, '删除测试友链', 'status=' + d.status + ' idx=' + idx);
}

// 9) 导航（走 /api/nav）
{
  const gname = '闭环分组 ' + Date.now();
  const r = await post('/api/nav', { nav: { groups: [{ id: 'closure', name: gname, desc: 'x', items: [{ name: '示例', url: 'https://example.com/', desc: 'd', icon: '' }] }] } });
  const data = await (await fetch(BASE + '/data/nav.json')).text();
  ok(r.status === 200, '保存导航', 'status=' + r.status);
  ok(data.includes(gname), '/data/nav.json 里出现新分组（导航页 fetch 它渲染）');
}

// 10) 问答（走 /api/qa，前台 /faq）
{
  const q = '闭环问题 ' + Date.now();
  const r = await post('/api/qa', { qa: { intro: '闭环导语', items: [{ q, a: '闭环答案', tag: '数据' }] } });
  const faq = await getText('/faq');
  ok(r.status === 200, '保存问答', 'status=' + r.status);
  ok(faq.includes(q) || (await (await fetch(BASE + '/data/qa.json')).text()).includes(q), '问答回读一致（/faq 或 data/qa.json）');
}

// 11) 文章生命周期：新增 → 数据/sitemap → 301 → 删除
{
  const title = '闭环文章 ' + Date.now();
  const add = await post('/api/articles', {
    action: 'add',
    article: { title, summary: '闭包测试摘要', body: '# 标题\n\n闭包测试正文', category: 'tech', tags: ['closure'] },
  });
  ok(add.status === 200, '新增文章', 'status=' + add.status + ' ' + (add.j && add.j.error ? add.j.error : ''));
  const list = (add.j && add.j.articles) || [];
  const art = list.find((a) => a && a.title === title);
  const slug = (art && art.slug) || '';
  ok(!!slug, '返回里带 slug', slug || 'none');
  const data = await (await fetch(BASE + '/data/articles.json')).text();
  ok(data.includes(title), '文章落盘 /data/articles.json');
  const sm = await getText('/sitemap.xml');
  ok(!!slug && sm.includes('/articles/' + slug + '.html'), 'sitemap 收录 .html 地址', slug);
  const canon = await fetch(BASE + '/articles/' + slug + '.html', { redirect: 'manual' });
  ok(canon.status === 200, '.html 规范地址 200', 'status=' + canon.status);
  const bare = await fetch(BASE + '/articles/' + slug, { redirect: 'manual' });
  ok(bare.status === 301, '不带 .html 自动 301', 'status=' + bare.status);
  const del = await post('/api/articles', { action: 'remove', id: art && art.id });
  ok(del.status === 200, '删除测试文章', 'status=' + del.status);
  const sm2 = await getText('/sitemap.xml');
  ok(!slug || !sm2.includes('/articles/' + slug + '.html'), 'sitemap 里已移除');
}

// 12) 体检接口与红条
{
  const sub = await (await fetch(BASE + '/api/submit')).json();
  ok(sub.status && typeof sub.status.keyFileOk === 'boolean', '体检接口给出 key 文件可读性', 'keyFileOk=' + (sub.status && sub.status.keyFileOk));
  const ai = await (await fetch(BASE + '/api/ai-usage')).json();
  const usage = ai.usage || ai;
  ok(typeof usage.used === 'number' && typeof usage.cap === 'number', 'AI 用量接口给出已用/上限', 'used=' + usage.used + ' cap=' + usage.cap);
  const admin = await (await fetch(BASE + '/admin')).text();
  ok(admin.includes('id="healthBar"'), '后台概览有体检红条容器');
}

// 还原
for (const [f, buf] of snapshot) fs.writeFileSync(f, buf);
// 还原后还要清掉 dev-server 进程内的假边缘缓存：warmEdge 把测试数据写进缓存了，
// 不清的话接下来跑 check-front-flows 会看到「导航只剩 1 条」这种假数据。
try { await fetch(BASE + '/__purge'); } catch (e) {}
console.log(fail === 0 ? '\n全部通过（已还原数据）' : '\n' + fail + ' 项失败（已还原数据）');
process.exit(fail === 0 ? 0 : 1);
