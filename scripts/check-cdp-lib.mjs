// 门禁：CDP 样板必须收在 scripts/lib/cdp.mjs 一处，且只许减少不许增加
import fs from 'node:fs';
import path from 'node:path';
import { runner } from './lib/cdp.mjs';

const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const LIB = 'scripts/lib/cdp.mjs';
const lib = fs.existsSync(LIB) ? fs.readFileSync(LIB, 'utf8') : '';

push('共享启动器存在', lib.length > 2000, lib ? lib.length + ' 字符' : '缺失');
push('导出 openCdp / shot / runner',
  /export async function openCdp/.test(lib) && /export async function shot/.test(lib) && /export function runner/.test(lib), '');

// 三个踩过的坑必须写在库里，而不是散在各门禁
push('端口用 listen(0) 由内核分配（不是随机数）', /listen\(0, '127\.0\.0\.1'/.test(lib), '');
push('统一 evaluate 的异常形状（exceptionDetails）', /exceptionDetails/.test(lib), '');
push('退出时 kill chrome 并删临时 profile', /proc\.kill\(\)/.test(lib) && /rmSync\(dir/.test(lib), '');

// 采用者：至少两个门禁已经改用共享启动器
const gates = fs.readdirSync('scripts').filter((f) => /^check-.+\.mjs$/.test(f));
const adopters = gates.filter((f) => fs.readFileSync(path.join('scripts', f), 'utf8').includes("from './lib/cdp.mjs'"));
push('至少 2 个门禁已改用共享启动器', adopters.length >= 2, adopters.join(',') || '0 个');

// 棘轮：还自带该样板的门禁只许减少
// 基线 118（第 26 轮：迁移 check-nav-order 之后）；每迁移一个就把它调小一次
// 注意：本文件在注释里提到这个字符串，必须把自己排除，否则统计会自己 +1
const BASELINE = 118;
const dup = gates.filter((f) => f !== 'check-cdp-lib.mjs' && fs.readFileSync(path.join('scripts', f), 'utf8').includes('/json/' + 'list'));
push('自带 CDP 样板的门禁数不超过基线（只许减少）', dup.length <= BASELINE, dup.length + ' / 基线 ' + BASELINE);

// 库自身不许悄悄变更协议：adopters 引用的三个名字必须都在导出里
const missing = [];
for (const f of adopters) {
  const s = fs.readFileSync(path.join('scripts', f), 'utf8');
  const imports = (s.match(/import \{([^}]+)\} from '\.\/lib\/cdp\.mjs'/) || [])[1] || '';
  for (const name of imports.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!new RegExp('export (async )?function ' + name + '\\b').test(lib)) missing.push(f + '→' + name);
  }
}
push('采用者引用的导出都存在', missing.length === 0, missing.join(',') || '');

const bad = runner(rows);
process.exit(bad === 0 ? 0 : 1);