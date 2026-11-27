// /api/rank 门禁：给机器读的排行榜 JSON
// 本地：node scripts/check-api-rank.mjs   （需要有 dev-server 在 8123）
// 线上：PROBE_BASE=https://github.661026.xyz node scripts/check-api-rank.mjs
const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/+$/, '');
let bad = 0;
const rows = [];
function ok(name, cond, detail) {
  rows.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) bad++;
}
const get = async (q) => {
  const r = await fetch(BASE + '/api/rank' + (q || ''), { headers: { accept: 'application/json' } });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, headers: r.headers, j };
};

const def = await get('');
ok('默认 200', def.status === 200, def.status);
ok('默认返回 20 条', def.j && def.j.returned === 20 && def.j.items.length === 20, def.j && def.j.returned);
ok('range 默认 week', def.j && def.j.range === 'week', def.j && def.j.range);
ok('总条数是 500（不是 0）', def.j && def.j.total >= 100, def.j && def.j.total);
ok('带 generatedAt', def.j && /^\d{4}-\d\d-\d\dT/.test(def.j.generatedAt || ''), def.j && def.j.generatedAt);
const it0 = def.j && def.j.items[0];
ok('第一条有 rank=1 / name / url / stars', !!(it0 && it0.rank === 1 && it0.name && /^https:\/\/github\.com\//.test(it0.url) && typeof it0.stars === 'number'), it0 && it0.name);
ok('rank 连续 1..20', !!(def.j && def.j.items.every((x, i) => x.rank === i + 1)));
ok('不泄露内部字段', !!(def.j && def.j.items.every((x) => !('tcount' in x) && !('issues' in x) && !('updated' in x) && !('pushed' in x))));
ok('有 CORS 与 5 分钟缓存', def.headers.get('cache-control').includes('s-maxage=300') && def.headers.get('access-control-allow-origin') === '*', def.headers.get('cache-control'));

const l3 = await get('?limit=3');
ok('limit=3 只回 3 条', l3.status === 200 && l3.j && l3.j.items.length === 3, l3.j && l3.j.returned);
ok('total 不因 limit 变小', l3.j && l3.j.total === def.j.total, l3.j && l3.j.total);
const l0 = await get('?limit=0');
ok('limit=0 → 400', l0.status === 400, l0.status);
const l101 = await get('?limit=101');
ok('limit=101 → 400', l101.status === 400, l101.status);
const labc = await get('?limit=abc');
ok('limit=abc → 400', labc.status === 400, labc.status);
ok('400 时说清范围', !!(l101.j && /1–100/.test(l101.j.error || '')), l101.j && l101.j.error);

const badRange = await get('?range=nope');
ok('未知 range → 400 并列出可选值', badRange.status === 400 && /week/.test((badRange.j && badRange.j.error) || ''), badRange.status);

const rust = await get('?lang=Rust&limit=5');
const rustOk = rust.status === 200 && rust.j && rust.j.items.every((x) => String(x.lang).toLowerCase() === 'rust');
ok('lang=Rust 只回 Rust', rustOk, rust.j && rust.j.total);
ok('lang 时 total 是过滤后的数', !!(rust.j && rust.j.total <= def.j.total), rust.j && rust.j.total);

const totalRange = await get('?range=total&limit=2');
ok('range=total 可用', totalRange.status === 200 && totalRange.j && totalRange.j.range === 'total' && totalRange.j.items.length === 2, totalRange.status);

const tsv = await fetch(BASE + '/api/rank?limit=3&format=tsv');
const tsvText = await tsv.text();
const tsvLines = tsvText.trim().split(String.fromCharCode(10));
ok('format=tsv 返回表格类型', tsv.status === 200 && /^text\/tab-separated-values/.test(tsv.headers.get('content-type') || ''), tsv.headers.get('content-type'));
ok('tsv 第一行是表头', /^rank\tname\tstars\tforks\tlang\ttopics\tdesc\turl$/.test(tsvLines[0] || ''), tsvLines[0]);
ok('tsv 行数 = limit + 1', tsvLines.length === 4, tsvLines.length);
ok('tsv 每行 8 列', tsvLines.slice(1).every((l) => l.split(String.fromCharCode(9)).length === 8), tsvLines[1] && tsvLines[1].split(String.fromCharCode(9)).length);
ok('tsv 带下载文件名', /attachment; filename="rank-week\.tsv"/.test(tsv.headers.get('content-disposition') || ''), tsv.headers.get('content-disposition'));
const badFmt = await get('?format=xml');
ok('format=xml → 400', badFmt.status === 400 && /json 或 tsv/.test((badFmt.j && badFmt.j.error) || ''), badFmt.status);

const firstWithTopics = (def.j && def.j.items || []).find((x) => Array.isArray(x.topics) && x.topics.length);
const pickTopic = (firstWithTopics && firstWithTopics.topics[0]) || 'desktop-app';
const byTopic = await get('?limit=100&topic=' + encodeURIComponent(pickTopic));
ok('topic 过滤：有结果', !!(pickTopic && byTopic.status === 200 && byTopic.j && byTopic.j.total > 0), pickTopic + ' → ' + (byTopic.j && byTopic.j.total));
ok('topic 过滤：每条都带该 topic', !!(byTopic.j && byTopic.j.items.every((x) => Array.isArray(x.topics) && x.topics.some((t) => String(t).toLowerCase() === pickTopic.toLowerCase()))), byTopic.j && byTopic.j.returned);
ok('topic 过滤：total 小于全量', !!(byTopic.j && byTopic.j.total < def.j.total), byTopic.j && byTopic.j.total);
const noneTopic = await get('?topic=zzzznope');
ok('不存在的 topic → 0 条（证明过滤生效）', noneTopic.status === 200 && noneTopic.j && noneTopic.j.total === 0 && noneTopic.j.items.length === 0, noneTopic.j && noneTopic.j.total);

for (const r of rows) console.log((r.ok ? '  OK   ' : '  FAIL ') + r.name + (r.detail ? '  → ' + r.detail : ''));
console.log(bad ? `\n${bad} FAILED of ${rows.length}` : `\nALL OK (${rows.length})  @${BASE}`);
process.exit(bad ? 1 : 0);