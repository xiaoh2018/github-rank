// 门禁聚合器自身的门禁：验证 scripts/check-all.mjs 与 package.json 的行为。
// 跑法：node scripts/check-harness.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rows = [];
const push = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

const run = (args, timeout) =>
  spawnSync(process.execPath, ['scripts/check-all.mjs'].concat(args), {
    encoding: 'utf8',
    timeout: timeout || 180000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8').replace(/^\uFEFF/, ''));
push('package.json 有 check 脚本', pkg.scripts && pkg.scripts.check === 'node scripts/check-all.mjs', pkg.scripts && pkg.scripts.check);
push('package.json 有 check:live', pkg.scripts && pkg.scripts['check:live'] === 'node scripts/check-all.mjs --live');
push('package.json 有 dev / deploy / push', !!(pkg.scripts && pkg.scripts.dev && pkg.scripts.deploy && pkg.scripts.push));
push('聚合器文件存在', fs.existsSync('scripts/check-all.mjs'));

const gates = fs.readdirSync('scripts').filter((f) => /^check-.+\.mjs$/.test(f) && !f.startsWith('check-all'));
push('发现的门禁 ≥ 100 个', gates.length >= 100, gates.length);

const src = fs.readFileSync('scripts/check-all.mjs', 'utf8');
push('默认跳过 check-live（除非 --live）', src.includes("flag('live')") && src.includes("!== 'check-live.mjs'"));

// 1) 只跑一个门禁：应通过
const one = run(['--only=check-lang', '--quiet'], 240000);
push('--only 单个门禁 exit 0', one.status === 0, one.status);
push('--only 输出含「共 1 个：通过 1」', /共 1 个：通过 1 · 失败 0/.test(one.stdout), (one.stdout || '').split('\n').slice(-4).join(' | '));

// 2) 不存在的门禁名：应 exit 2 且给出原因
const bad = run(['--only=nope'], 60000);
push('不存在的门禁 exit 2', bad.status === 2, bad.status);
push('给出可读的原因', /没有选中任何门禁/.test(bad.stderr || ''), (bad.stderr || '').trim().split('\n')[0]);

// 3) JSON 输出
const tmp = path.join(os.tmpdir(), 'ghrank-check-all-' + Date.now() + '.json');
const json = run(['--only=check-lang', '--quiet', '--json=' + tmp], 240000);
let parsed = null;
try { parsed = JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch {}
push('--json 写出结果文件', json.status === 0 && !!parsed, parsed ? { total: parsed.total, passed: parsed.passed, failed: parsed.failed.length } : 'no json');
push('JSON 里记录了门禁名与耗时', !!(parsed && parsed.results && parsed.results[0] && parsed.results[0].file === 'check-lang.mjs' && parsed.results[0].ms > 0));
try { fs.unlinkSync(tmp); } catch {}

const bad2 = rows.filter((r) => !r.ok).length;
console.log('\n' + (bad2 ? bad2 + ' FAILED' : 'ALL OK (' + rows.length + ')'));
process.exit(bad2 ? 1 : 0);
