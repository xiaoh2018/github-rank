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
  const home = await getText('/?probe=' + Date.now());
  ok(r.status === 200, '保存 SEO 设置', 'status=' + r.status);
  ok(home.includes(title), '首页 <title> 用了新标题');
  ok(home.includes(desc), '首页 meta description 用了新描述');
}

// 2) 主题：data-theme
{
  const r = await post('/api/site', { section: 'theme', value: { name: 'ink', allowUser: true } });
  const home = await getText('/?probe=' + Date.now());
  ok(r.status === 200, '保存主题 ink', 'status=' + r.status);
  ok(/data-theme="ink"/.test(home), '首页 html 带 data-theme="ink"');
}

// 3) 布局：body data-layout / data-side / data-users
{
  const r = await post('/api/site', { section: 'layout', value: { mode: 'triple', side: 'below', users: 'double' } });
  const home = await getText('/?probe=' + Date.now());
  ok(r.status === 200, '保存布局三档', 'status=' + r.status);
  ok(home.includes('data-layout="triple"') && home.includes('data-side="below"') && home.includes('data-users="double"'), '首页 body 三属性都写上了');
}

// 4) 广告位：开启 home-top 自定义 HTML
{
  const mark = 'ADCLOSURE-' + Date.now();
  const slots = JSON.parse(JSON.stringify((site.ad && site.ad.slots) || {}));
  slots['home-top'] = { enabled: true, html: '<div>' + mark + '</div>', every: undefined, link: '', modal: '' };
  const r = await post('/api/site', { section: 'ad', value: { slots } });
  const data = await (await fetch(BASE + '/data/site.json?probe=' + Date.now())).text();
  ok(r.status === 200, '保存广告位 home-top', 'status=' + r.status);
  ok(data.includes(mark), '/data/site.json 里出现广告标记（前台 fetch 的就是它）');
}

// 5) 联系方式
{
  const mail = 'closure' + Date.now() + '@example.com';
  const r = await post('/api/site', { section: 'contact', value: { enabled: true, title: '闭环联系', wechat: 'wx-closure', qrUrl: '', email: mail, note: 'note' } });
  const data = await (await fetch(BASE + '/data/site.json?probe=' + Date.now())).text();
  ok(r.status === 200, '保存联系方式', 'status=' + r.status);
  ok(data.includes(mail), 'contact.email 回读一致');
}

// 6) 备案
{
  const r = await post('/api/site', { section: 'beian', value: { enabled: true, icp: '闭环ICP-1', icpUrl: 'https://beian.miit.gov.cn/', police: '', policeUrl: '', text: '' } });
  const data = await (await fetch(BASE + '/data/site.json?probe=' + Date.now())).text();
  ok(r.status === 200 && data.includes('闭环ICP-1'), '保存备案并回读');
}

// 7) 运行时（密钥/额度）—— 只验证能存能读，不触发外部请求
{
  const r = await post('/api/site', { section: 'runtime', value: { aiCap: 321, emails: 'closure@example.com', baiduToken: 'closure-token-1', indexNowKey: (site.runtime && site.runtime.indexNowKey) || '' } });
  const data = await (await fetch(BASE + '/data/site.json?probe=' + Date.now())).text();
  ok(r.status === 200 && data.includes('"aiCap": 321'), 'runtime.aiCap 回读一致');
  ok(data.includes('closure-token-1'), 'runtime.baiduToken 回读一致');
}

// 8) 友链（走 /api/links，接口是 add / remove，不是整表替换）
{
  const name = '闭环友链 ' + Date.now();
  const url = 'https://example.com/closure-' + Date.now() + '/';
  const r = await post('/api/links', { action: 'add', name, url, desc: 'closure' });
  const data = await (await fetch(BASE + '/data/links.json?probe=' + Date.now())).text();
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
  const data = await (await fetch(BASE + '/data/nav.json?probe=' + Date.now())).text();
  ok(r.status === 200, '保存导航', 'status=' + r.status);
  ok(data.includes(gname), '/data/nav.json 里出现新分组（导航页 fetch 它渲染）');
}

// 10) 问答（走 /api/qa，前台 /faq）
{
  const q = '闭环问题 ' + Date.now();
  const r = await post('/api/qa', { qa: { intro: '闭环导语', items: [{ q, a: '闭环答案', tag: '数据' }] } });
  const faq = await getText('/faq?probe=' + Date.now());
  ok(r.status === 200, '保存问答', 'status=' + r.status);
  ok(faq.includes(q) || (await (await fetch(BASE + '/data/qa.json?probe=' + Date.now())).text()).includes(q), '问答回读一致（/faq 或 data/qa.json）');
}

// 还原
for (const [f, buf] of snapshot) fs.writeFileSync(f, buf);
console.log(fail === 0 ? '\n全部通过（已还原数据）' : '\n' + fail + ' 项失败（已还原数据）');
process.exit(fail === 0 ? 0 : 1);
