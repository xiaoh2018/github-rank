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

for (const r of rows) console.log((r.ok ? '  OK   ' : '  FAIL ') + r.name + (r.detail ? '  → ' + r.detail : ''));
console.log(bad ? `\n${bad} FAILED of ${rows.length}` : `\nALL OK (${rows.length})  @${BASE}`);
process.exit(bad ? 1 : 0);