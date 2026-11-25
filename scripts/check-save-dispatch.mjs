// 后台保存派发自查：每个 data-save="X" 都必须有一条**可达**的分支。
// 踩过的坑：if (sec === 'qa') 被误嵌进 if (sec === 'nav') 里面（缩进还是 6 空格，肉眼看不出），
// 于是点「保存问答」时落到了 /api/site（section=qa 不在 SITE_SECTIONS），后台报「section 只能是…」。
// 所以这里不能只看缩进，必须按大括号深度判断分支是否在 api('/api/site') 的同一层级。
import fs from 'node:fs';

const raw = fs.readFileSync('worker.js', 'utf8');
const src = raw.split(/\r?\n/);
const problems = [];
let checked = 0;

// 逐行计算「进入本行前的花括号深度」，跳过字符串字面量与行注释
function depthMap(lines) {
  let depth = 0;
  const out = [];
  for (const line of lines) {
    out.push(depth);
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '/' && line[i + 1] === '/') break;
      if (c === "'" || c === '"' || c === '`') {
        const q = c;
        i++;
        while (i < line.length && line[i] !== q) { if (line[i] === '\\') i++; i++; }
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
  }
  return out;
}
const depths = depthMap(src);

// 1) 所有 data-save 的 section
const sections = new Set();
for (const line of src) {
  const m = line.match(/data-save="([a-z]+)"/g);
  if (m) m.forEach((x) => sections.add(x.slice(11, -1)));
}

// 2) 定位派发块
const startIdx = src.findIndex((l) => /querySelectorAll\('\[data-save\]'\)|\[data-save\]'\)\.forEach/.test(l));
const siteIdx = src.findIndex((l) => /api\('\/api\/site', \{ method: 'POST'/.test(l));
if (startIdx < 0 || siteIdx < 0 || siteIdx < startIdx) {
  console.log('找不到保存派发代码块（data-save 监听器 → api(/api/site)），跳过检查');
  process.exit(0);
}
const siteDepth = depths[siteIdx];

// 3) 同一层级（深度 == siteDepth）的 if (sec === 'X') 才是可达分支
const baseIfs = new Set();
for (let i = startIdx; i <= siteIdx; i++) {
  const m = src[i].match(/if \(sec === '([a-z]+)'\) \{/);
  if (!m) continue;
  if (depths[i] === siteDepth) baseIfs.add(m[1]);
  else problems.push(`if (sec === '${m[1]}') 在第 ${i + 1} 行，但被套进了更深的块（深度 ${depths[i]}，应为 ${siteDepth}）→ 这个分支不可达`);
}

// 4) 专用接口 section 必须有顶层分支 + 调用对应接口
const SPECIAL = { qa: '/api/qa', nav: '/api/nav' };
for (const sec of Object.keys(SPECIAL)) {
  if (!sections.has(sec)) continue;
  checked++;
  if (!baseIfs.has(sec)) problems.push(`data-save="${sec}" 没有可达分支 → 点保存会落到 /api/site 被 400 拒`);
  const hasApi = src.slice(startIdx, siteIdx + 1).some((l) => l.includes(`'${SPECIAL[sec]}'`));
  if (!hasApi) problems.push(`data-save="${sec}" 附近没有调用 ${SPECIAL[sec]}`);
}

// 5) 普通 section 必须在 SITE_SECTIONS 里
const listMatch = raw.match(/const SITE_SECTIONS = \[([^\]]*)\]/);
if (listMatch) {
  const allowed = new Set(listMatch[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean));
  for (const sec of sections) {
    if (SPECIAL[sec]) continue;
    checked++;
    if (!allowed.has(sec)) problems.push(`data-save="${sec}" 不在 SITE_SECTIONS 里，POST 会被 400 拒`);
  }
}

// 6) 重复 id（同一个 id 出现两次，$('id') 只命中第一个）
const ids = new Map();
src.forEach((line, i) => {
  const m = line.match(/\sid="([A-Za-z][\w-]*)"/g);
  if (m) m.forEach((x) => {
    const id = x.slice(5, -1);
    if (!ids.has(id)) ids.set(id, []);
    ids.get(id).push(i + 1);
  });
});
for (const [id, lines] of ids) if (lines.length > 1) problems.push(`id="${id}" 重复 ${lines.length} 次（行 ${lines.join(', ')}）`);

if (problems.length) {
  console.log('发现 ' + problems.length + ' 个问题：');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exit(1);
}
console.log(`✓ 保存派发全部可达（检查 ${checked} 个 section），无重复 id`);
