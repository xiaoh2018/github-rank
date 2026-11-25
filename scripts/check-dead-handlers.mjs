// 扫描后台脚本里「被读取但从来没被渲染」的 data-* 属性 —— 这类问题就是问答面板
// 「有事件没按钮」的翻版：逻辑写了，元素没输出，用户点了没反应 / 非扫码。
// 只做静态文本扫描：worker.js 里同时含 ADMIN_PAGE 的 html 与脚本，所以「引用」与
// 「产出」都在这一个文件里比对。
import fs from 'node:fs';

const src = fs.readFileSync('worker.js', 'utf8');

// 1) 收集所有读取点：closest('[data-x]') / matches('[data-x]') / getAttribute('data-x')
const readRe = /(?:closest|matches|querySelector(?:All)?)\(\s*'\[(data-[a-z0-9-]+)/g;
const attrRe = /getAttribute\(\s*'(data-[a-z0-9-]+)'/g;
const reads = new Map();
for (const re of [readRe, attrRe]) {
  let m;
  while ((m = re.exec(src))) {
    const key = m[1];
    if (!reads.has(key)) reads.set(key, 0);
    reads.set(key, reads.get(key) + 1);
  }
}

// 2) 判断某个 data-* 是否有产出：模板里写成 data-x=" 或 data-x=' 或 data-x='+i+'，
//    或者通过 setAttribute('data-x', …) 动态写入。
const produced = new Set();
for (const key of reads.keys()) {
  const esc = key.replace(/-/g, '\\-');
  const inHtml = new RegExp(esc + '\\s*=', 'g').test(src);
  const viaSet = new RegExp("setAttribute\\(\\s*'" + esc + "'", 'g').test(src);
  if (inHtml || viaSet) produced.add(key);
}

const missing = [...reads.keys()].filter((k) => !produced.has(k)).sort();
console.log('读取的 data-* 属性：' + reads.size + ' 个');
if (!missing.length) {
  console.log('全部有对应产出 ✓');
  process.exit(0);
}
console.log('以下属性被脚本读取，但整份 worker.js 里找不到任何产出（很可能是死逻辑）：');
for (const k of missing) console.log('  - ' + k + '（被读 ' + reads.get(k) + ' 次）');
process.exit(1);
