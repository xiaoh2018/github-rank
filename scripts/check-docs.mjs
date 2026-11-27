// 门禁：文档不能悄悄说谎。
// 只验「当前状态」类断言（历史变更记录允许描述过去），核心是三类：
//   1) 界面上的按钮/数量与源码一致（English → 描述：中文；广告位 8 → 10）
//   2) 文档里出现的广告位 id 与 worker 的 AD_SLOTS 完全对应
//   3) 引用的截图 / 脚本真实存在，且不写死会漂移的数字
import fs from 'node:fs';

const rows = [];
const push = (name, ok, detail) => {
  rows.push({ name, ok: !!ok, detail });
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail ? '  → ' + String(detail).slice(0, 90) : ''));
};

const intro = fs.readFileSync('docs/项目介绍.md', 'utf8');
const manual = fs.readFileSync('docs/操作手册.md', 'utf8');
const worker = fs.readFileSync('worker.js', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

const slots = (worker.match(/const AD_SLOTS = \[[\s\S]*?\n\];/) || [''])[0]
  .split('\n')
  .map((l) => (l.match(/id: '([a-z-]+)'/) || [])[1])
  .filter(Boolean);

// 1. 两份文档都在、有实质内容
push('文档存在且非空（项目介绍 / 操作手册）', intro.length > 2000 && manual.length > 5000, intro.length + 'B / ' + manual.length + 'B');

// 2. 页头工具栏的「当前描述」不再写 English
const toolbarLine = (manual.split(/\r?\n/).find((l) => l.indexOf('右边工具栏') >= 0) || '');
const introHeaderRow = (intro.split(/\r?\n/).find((l) => l.indexOf('顶部导航') >= 0) || '');
push('操作手册页头描述已改成「描述：中文」', toolbarLine.indexOf('描述：中文') >= 0 && toolbarLine.indexOf('English') < 0);
push('项目介绍页头描述已改成「描述：中文」', introHeaderRow.indexOf('描述：中文') >= 0 && introHeaderRow.indexOf('English') < 0);

// 3. 广告位数量：8 → 10（含 7 固定 + 3 信息流）
const manualAdLine = (manual.split(/\r?\n/).find((l) => l.indexOf('site.json ad.slots') >= 0) || '');
push('操作手册：广告位写成 10 个（7 固定 + 3 信息流）',
  manualAdLine.indexOf('10 个广告位') >= 0 && manualAdLine.indexOf('7 个固定位') >= 0 && manualAdLine.indexOf('5 个固定位') < 0);
push('项目介绍：广告位写成 10 个位置', intro.indexOf('10 个位置') >= 0 && intro.indexOf('8 个位置') < 0);
push('文档里不再出现「8 个广告位」', manual.indexOf('8 个广告位') < 0 && intro.indexOf('8 个广告位') < 0);

// 4. 广告位 id：文档与源码双向覆盖
const missing = slots.filter((id) => manual.indexOf('`' + id + '`') < 0);
push('worker 的 10 个广告位 id 全部写在操作手册里', slots.length === 10 && missing.length === 0, '缺：' + (missing.join(',') || '无'));
const docIds = (manual.match(/`(home-top|list-top|list-bottom|sidebar|article|article-side|article-after|list-inline|article-inline|nav-inline)`/g) || [])
  .map((s) => s.replace(/`/g, ''))
  .filter((v, i, a) => a.indexOf(v) === i);
const extra = docIds.filter((id) => slots.indexOf(id) < 0);
push('文档没写源码里不存在的广告位 id', extra.length === 0, '多出：' + (extra.join(',') || '无'));

// 5. SW 缓存版本：文档举例必须与 sw.js 一致，且不再写老的 v40
const cache = (sw.match(/const CACHE = '([^']+)'/) || [])[1] || '';
push('sw.js 的 CACHE 版本号出现在操作手册里', !!cache && manual.indexOf(cache) >= 0, cache);
push('文档里不再出现老的 ghrank-shell-v40', manual.indexOf('ghrank-shell-v40') < 0);

// 6. 引用的截图与脚本必须真实存在
const flat = (s) => s.replace(/\r?\n/g, ' ');
const relFiles = [];
for (const s of [intro, manual]) {
  for (const m of s.matchAll(/\]\((shots\/[A-Za-z0-9._-]+\.(?:png|jpg))\)/g)) relFiles.push('docs/' + m[1]);
  for (const m of s.matchAll(/`?(scripts\/[A-Za-z0-9._-]+\.mjs)`?/g)) relFiles.push(m[1]);
}
const uniq = [...new Set(relFiles)];
const gone = uniq.filter((p) => !fs.existsSync(p));
push('文档引用的截图/脚本都存在', gone.length === 0, gone.length ? '缺 ' + gone.length + '：' + gone.slice(0, 3).join(',') : '检查 ' + uniq.length + ' 个引用');

// 7. 不写死会漂移的数字
push('不再写死「90+ 断言」这类数字', manual.indexOf('90+ 断言') < 0 && intro.indexOf('90+ 断言') < 0);

// 8. 文档提到的门禁脚本都能被聚合器跑到（防止文档指向已删除的门禁）
const gateNames = [...new Set((manual.match(/scripts\/(check-[A-Za-z0-9._-]+\.mjs)/g) || []).map((s) => s.replace('scripts/', '')))];
const gateGone = gateNames.filter((f) => !fs.existsSync('scripts/' + f));
push('文档点名的 check-* 门禁都存在', gateGone.length === 0, gateGone.join(',') || '共 ' + gateNames.length + ' 个');

const failed = rows.filter((r) => !r.ok).length;
console.log('\n' + (failed ? 'FAILED ' + failed + '/' + rows.length : 'ALL OK (' + rows.length + ')'));
process.exit(failed ? 1 : 0);