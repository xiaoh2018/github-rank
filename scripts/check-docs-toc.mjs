// docs/优化建议.md 的目录自检：编号唯一、非递减、每节有正文、交叉引用可解析（允许多种标题格式）。
import fs from 'node:fs';

const F = 'docs/优化建议.md';
let bad = 0;
const ck = (name, ok, extra = '') => {
  if (!ok) bad++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra ? '  → ' + extra : ''));
};

const raw = fs.readFileSync(F, 'utf8');
const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));
ck('文档存在且体积合理（>10KB）', raw.length > 10000, raw.length + ' 字符');

// A 类：## §N 标题；B 类：## N. 标题（早期批次用的旧格式）
const secA = [];
const secB = [];
lines.forEach((l, i) => {
  const a = l.match(/^##\s*§\s*([0-9]+[a-z]?)/);
  if (a) secA.push({ label: a[1], line: i + 1, text: l });
  const b = l.match(/^##\s*([0-9]+)\./);
  if (b) secB.push({ label: b[1], line: i + 1, text: l, title: l.replace(/^##\s*[0-9]+\.\s*/, '').trim() });
});

ck('「## §N」小节数量合理（>=100）', secA.length >= 100, secA.length + ' 节');
ck('「## N.」旧格式小节数量合理（>=50）', secB.length >= 50, secB.length + ' 节');

const labels = secA.map((x) => x.label);
const dup = labels.filter((x, i) => labels.indexOf(x) !== i);
ck('「## §N」编号唯一', dup.length === 0, dup.length ? '重复：§' + dup.join('、§') : '');

const num = (l) => {
  const m = l.match(/^([0-9]+)([a-z]?)$/);
  if (!m) return NaN;
  return Number(m[1]) + (m[2] ? 0.5 : 0);
};
let last = -1;
const outOfOrder = [];
for (const s of secA) {
  const n = num(s.label);
  if (Number.isFinite(n)) {
    if (n < last) outOfOrder.push('§' + s.label + ' @' + s.line);
    last = n;
  }
}
ck('「## §N」按文件顺序非递减', outOfOrder.length === 0, outOfOrder.slice(0, 4).join('、'));

// 每节至少有 3 行正文（到下一个 ## 或 ### 之前）
let thin = [];
for (let i = 0; i < secA.length; i++) {
  const start = secA[i].line;
  const end = secA[i + 1] ? secA[i + 1].line : lines.length;
  const body = lines.slice(start, end - 1).filter((l) => l.trim().length > 0);
  if (body.length < 3) thin.push('§' + secA[i].label + '(' + body.length + '行)');
}
ck('每节至少 3 行正文', thin.length === 0, thin.slice(0, 4).join('、'));

// 标题不能太短
const shortT = secA.filter((s) => s.text.replace(/^## §[0-9]+[a-z]?\s*/, '').trim().length < 4);
ck('每节标题不少于 4 字', shortT.length === 0, shortT.slice(0, 3).map((s) => '§' + s.label).join('、'));

// 有编号说明段，且说明里点明「§N = 第 N 轮」与 §20b 重号
const noteIdx = lines.findIndex((l) => /^## 编号说明/.test(l));
ck('有「编号说明」段', noteIdx >= 0, noteIdx >= 0 ? 'line ' + (noteIdx + 1) : '');
const noteBlock = noteIdx >= 0 ? lines.slice(noteIdx, noteIdx + 20).join('\n') : '';
ck('说明里写清「§N = 第 N 轮」', /§N/.test(noteBlock) && /第 N 轮/.test(noteBlock));
ck('说明里提到 §20b 那次重号', /§20b/.test(noteBlock));

// 交叉引用可解析：正文里「见 §N」必须能在 A 或 B 类里找到
const exist = new Set([...labels, ...secB.map((x) => x.label)]);
const refs = [];
lines.forEach((l, i) => {
  const re = /见\s*§([0-9]+[a-z]?)/g;
  let m;
  while ((m = re.exec(l))) refs.push({ label: m[1], line: i + 1 });
});
const dangling = refs.filter((r) => !exist.has(r.label));
ck('正文里「见 §N」的引用都能命中', dangling.length === 0, dangling.length ? '悬空：§' + [...new Set(dangling.map((d) => d.label))].join('、§') : refs.length + ' 处引用');

// 没有空编号
const emptyNum = lines.filter((l) => /^## §\s*$/.test(l));
ck('没有空编号（## § 后必须跟编号）', emptyNum.length === 0, emptyNum.length + ' 处');

console.log(bad === 0 ? '\nALL OK' : '\n' + bad + ' FAILED');
process.exit(bad === 0 ? 0 : 1);
