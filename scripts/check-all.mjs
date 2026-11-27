// 一条命令跑全部门禁。
// 用法：
//   node scripts/check-all.mjs                 # 跑本地全部（跳过 check-live，它要线上已部署）
//   node scripts/check-all.mjs --live          # 连 check-live 一起跑
//   node scripts/check-all.mjs --only=check-lang,check-worker
//   node scripts/check-all.mjs --skip=check-a11y --quiet
//   node scripts/check-all.mjs --json=docs/tmp-check-all.json
// 退出码：0 全绿 / 1 有失败 / 2 参数或环境错误
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const value = (name, def) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
};

const DIR = path.join(process.cwd(), 'scripts');
const TIMEOUT = Number(value('timeout', '300')) * 1000;
const INCLUDE_LIVE = flag('live');
const QUIET = flag('quiet');
const ONLY = String(value('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const SKIP = String(value('skip', '')).split(',').map((s) => s.trim()).filter(Boolean);
const JSON_OUT = value('json', '');

if (!fs.existsSync(DIR)) {
  console.error('找不到 scripts/ 目录，请在项目根目录运行');
  process.exit(2);
}

const all = fs
  .readdirSync(DIR)
  .filter((f) => /^check-.+\.mjs$/.test(f))
  .filter((f) => !f.startsWith('check-all'))
  .sort();

let picked = all;
if (ONLY.length) picked = all.filter((f) => ONLY.some((o) => f === o || f === o + '.mjs'));
if (SKIP.length) picked = picked.filter((f) => !SKIP.some((s) => f === s || f === s + '.mjs'));
if (!INCLUDE_LIVE && !ONLY.includes('check-live.mjs')) picked = picked.filter((f) => f !== 'check-live.mjs');

if (!picked.length) {
  console.error('没有选中任何门禁：检查 --only / --skip 的写法（名字是 check-xxx.mjs）');
  process.exit(2);
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join('scripts', file)], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const cap = (buf) => {
      out += buf.toString('utf8');
      if (out.length > 60000) out = out.slice(-40000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, TIMEOUT);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      resolve({
        file,
        code,
        timedOut,
        ms: Date.now() - started,
        tail: lines.slice(-6).join('\n'),
        last: lines.slice(-1)[0] || '',
      });
    });
  });
}

const results = [];
console.log('跑 ' + picked.length + ' 个门禁' + (INCLUDE_LIVE ? '（含线上 check-live）' : '') + '，单个超时 ' + TIMEOUT / 1000 + 's\n');
for (const file of picked) {
  process.stdout.write('  ' + file.replace(/\.mjs$/, '').padEnd(28));
  const r = await runOne(file);
  const ok = r.code === 0 && !r.timedOut;
  results.push(r);
  if (ok) {
    if (!QUIET) process.stdout.write('通过  ' + (r.ms / 1000).toFixed(1) + 's\n');
    else process.stdout.write('ok\n');
  } else {
    process.stdout.write((r.timedOut ? '超时' : '失败') + '  ' + (r.ms / 1000).toFixed(1) + 's\n');
    if (r.tail) console.log(r.tail.split('\n').map((l) => '      ' + l).join('\n'));
  }
}

const failed = results.filter((r) => r.code !== 0 || r.timedOut);
const totalS = results.reduce((s, r) => s + r.ms, 0) / 1000;
console.log('\n' + '-'.repeat(60));
console.log(
  '共 ' + results.length + ' 个：通过 ' + (results.length - failed.length) + ' · 失败 ' + failed.length +
  ' · 用时 ' + totalS.toFixed(1) + 's'
);
if (failed.length) {
  console.log('\n失败清单：');
  for (const f of failed) console.log('  ✗ ' + f.file + (f.timedOut ? '（超时）' : '（exit ' + f.code + '）'));
}
if (JSON_OUT) {
  const payload = {
    at: new Date().toISOString(),
    cwd: process.cwd(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.map((f) => ({ file: f.file, code: f.code, timedOut: f.timedOut, last: f.last })),
    seconds: Number(totalS.toFixed(1)),
    results: results.map((r) => ({ file: r.file, code: r.code, ms: r.ms, timedOut: r.timedOut, last: r.last })),
  };
  fs.writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log('\n结果已写入 ' + JSON_OUT);
}
console.log(failed.length ? '\n有门禁没过。' : '\n全部通过。');
process.exit(failed.length ? 1 : 0);
