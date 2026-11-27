// 文档里写的接口清单必须与 worker.js 的真实路由一致（防止文档越写越旧）
import fs from 'node:fs';
let bad = 0;
const rows = [];
const ok = (name, cond, detail) => { rows.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) }); if (!cond) bad++; };

const worker = fs.readFileSync('worker.js', 'utf8');
const doc = fs.readFileSync('docs/项目介绍.md', 'utf8');
const routes = [...new Set([...worker.matchAll(/url\.pathname === '(\/api\/[a-z0-9-]+)'/g)].map((m) => m[1]))].sort();
const panes = [...new Set([...worker.matchAll(/id="pane-([a-z]+)"/g)].map((m) => m[1]))];

ok('worker 里能数出接口路由（≥15）', routes.length >= 15, routes.length);
const missing = routes.filter((r) => !doc.includes(r));
ok('项目介绍写到了全部接口', missing.length === 0, missing.join(' ') || 'all covered');
ok('接口总数与文档一致', doc.includes('共 20 个') === (routes.length === 20), 'routes=' + routes.length);
ok('后台标签页数与文档一致', doc.includes(panes.length + ' 个标签页'), 'panes=' + panes.length);
ok('/api/rank 的参数写全了', ['range', 'limit', 'lang', 'topic', 'format=tsv'].every((k) => doc.includes(k)), '');
ok('文档没再提旧的 9 个标签页', !/9 个标签页/.test(doc), '');
ok('文档没再写单文件 repos.js', !/repos\.js（/.test(doc), '');
ok('数据文件口径含 repos-<range>', doc.includes('repos-<range>'), '');

for (const r of rows) console.log((r.ok ? '  OK   ' : '  FAIL ') + r.name + (r.detail ? '  → ' + r.detail : ''));
console.log(bad ? `\n${bad} FAILED of ${rows.length}` : `\nALL OK (${rows.length})`);
process.exit(bad ? 1 : 0);