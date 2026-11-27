import fs from 'node:fs';
import vm from 'node:vm';

let bad = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'OK   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) bad++; };

// 1) 数据文件体积与字段
const file = 'data/repos-week.js';
const raw = fs.readFileSync(file, 'utf8');
const bytes = Buffer.byteLength(raw);
const sandbox = { window: {} };
vm.runInNewContext(raw, sandbox);
const repos = sandbox.window.__GHRANK_RANGES__.week.repos;
const per = bytes / repos.length;
ok('week 数据文件 < 400KB（含 desc_zh 译文）', bytes < 400 * 1024, Math.round(bytes / 1024) + 'KB');
ok('每条记录 < 900 字节（desc + desc_zh 双份文案）', per < 900, Math.round(per) + 'B/条');

const sample = repos.slice(0, 200);
ok('不再落盘 url 字段（前端拼）', sample.every((r) => r.url === undefined));
ok('时间戳是 epoch 秒（数字）', sample.every((r) => r.updated == null || typeof r.updated === 'number'));
ok('时间戳数值合理（>2020 年）', sample.every((r) => r.updated == null || r.updated > 1577836800));
ok('topics 最多 3 个', sample.every((r) => !r.topics || r.topics.length <= 3));
ok('有总数时带 tcount', sample.every((r) => !r.topics || typeof r.tcount === 'number'));
ok('必填字段齐全（name/stars）', sample.every((r) => typeof r.name === 'string' && typeof r.stars === 'number'));

// 2) 前端按需拼 URL 与容错
const bundle = fs.readFileSync('js/bundle.js', 'utf8');
ok('bundle 有 repoUrl() 兜底', bundle.indexOf('function repoUrl(r)') >= 0);
ok('bundle 时间戳兼容数字与字符串', bundle.indexOf("typeof iso === 'number' ? iso * 1000 : Date.parse(iso)") >= 0);
ok('bundle 对 topics 做了空值兜底', bundle.indexOf('const tagList = r.topics || [];') >= 0);

// 3) 预载策略
const worker = fs.readFileSync('worker.js', 'utf8');
ok('首页预载 repos-week.js', worker.indexOf('</data/repos-week.js>; rel=preload; as=script') >= 0);
ok('不再重复预载 bundle.js（会下两份）', worker.indexOf("'</js/bundle.js>; rel=preload; as=script, ") < 0);
ok('范围文件地址不带 ?v=（与预载 URL 一致）', bundle.indexOf('s.src = file;') >= 0 && bundle.indexOf("file + (meta && meta.generatedAt ? '?v='") < 0);

console.log(bad === 0 ? 'ALL OK' : bad + ' FAILED');
process.exit(bad ? 1 : 0);
