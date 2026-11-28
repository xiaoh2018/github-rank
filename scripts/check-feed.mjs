const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

const res = await fetch(BASE + '/feed.xml');
const xml = await res.text();
push('/feed.xml 返回 200', res.status === 200, res.status);
push('content-type 是 RSS', /application\/rss\+xml/.test(res.headers.get('content-type') || ''), res.headers.get('content-type'));
push('缓存 10 分钟（s-maxage=600）', /s-maxage=600/.test(res.headers.get('cache-control') || ''), res.headers.get('cache-control'));
push('是 RSS 2.0 文档', xml.startsWith('<?xml') && xml.includes('<rss version="2.0">') && xml.includes('</channel></rss>'));
push('标题写明「近 7 天 Top 50」', /<title>[^<]*Top 50[^<]*<\/title>/.test(xml));

const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
push('正好 50 条', items.length === 50, items.length);

const links = items.map((it) => (it.match(/<link>([^<]+)<\/link>/) || [])[1] || '');
push('每条都有 github 链接', links.length === items.length && links.every((u) => u.startsWith('https://github.com/')), links[0]);
push('每条都有 guid 与 pubDate', items.every((it) => it.includes('<guid') && it.includes('<pubDate>')), items.length);
push('标题格式「仓库名 ★星数」', items.every((it) => /★\d+/.test(it)), (items[0].match(/<title>([^<]+)<\/title>/) || [])[1]);

const meta = (xml.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/) || [])[1] || '';
push('lastBuildDate 是合法时间', !isNaN(new Date(meta).getTime()), meta);

// 与 /api/rank 对齐：第一条的星数应当是全站周榜第一
const rank = await (await fetch(BASE + '/api/rank?range=week&limit=1')).json();
const topStars = rank && rank.items && rank.items[0] ? rank.items[0].stars : null;
const firstStars = Number(((items[0].match(/★(\d+)/) || [])[1]) || '0');
push('第一条与 /api/rank 的第一名一致', topStars != null && firstStars === topStars, 'feed=' + firstStars + ' api=' + topStars);

const home = await (await fetch(BASE + '/')).text();
push('首页 head 声明了榜单 RSS', /application\/rss\+xml[^>]*href="\/feed\.xml"/.test(home) || home.includes('href="/feed.xml"'));
push('首页「关于本站」里有订阅入口', home.includes('id="feedLink"') && home.includes('榜单 Top 50（RSS）'));

const llms = await (await fetch(BASE + '/llms.txt')).text();
push('llms.txt 里写了榜单订阅源', llms.includes('/feed.xml'), '');

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + r.detail : ''));
}
console.log('');
console.log(bad ? bad + ' FAILED of ' + rows.length : 'ALL OK (' + rows.length + ')  @' + BASE);
process.exit(bad ? 1 : 0);