// 后台每个板块的「接线」自查：
// 1) TABS 里的 tab 都有对应 pane，反之 pane 也都在 TABS 里
// 2) 每个 pane 至少有一个保存入口（data-save="sec" 或已知的专用按钮）
// 3) 每个 data-save 的 sec 都在 SITE_SECTIONS 里（否则保存必 400）
// 4) 每个 pane 里的 input/textarea/select 的 id，脚本里要么有 $('id') 读、要么被 data-* 遍历读
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (cond, msg, extra = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg + (extra ? '  ← ' + extra : ''));
  if (!cond) fail++;
};

const tabsM = src.match(/var TABS = \[([^\]]+)\]/);
const tabs = tabsM ? tabsM[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
const panes = [...src.matchAll(/<section class="pane" id="pane-([a-z]+)"/g)].map((m) => m[1]);
const secsM = src.match(/const SITE_SECTIONS = \[([^\]]+)\]/);
const secs = secsM ? secsM[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];

console.log('== A. TABS / pane 一一对应 ==');
ok(tabs.length > 0, 'TABS 能解析', tabs.join(','));
ok(tabs.length === panes.length, 'TABS 与 pane 数量一致', tabs.length + ' vs ' + panes.length);
for (const t of tabs) ok(panes.includes(t), 'tab ' + t + ' 有对应 pane');
for (const p of panes) ok(tabs.includes(p), 'pane ' + p + ' 出现在 TABS');

console.log('\n== B. 每个 pane 都有保存入口 ==');
const dedicated = {
  overview: ['keepBtn', 'refreshBtn'],
  articles: ['artNew', 'catAdd'],
  nav: ['navAddGroup'],
  submit: ['subRun'],
  keys: ['trReload'],
  translate: ['trRun'],
  links: ['addLinkBtn'],
};
const paneHtml = (name) => {
  const i = src.indexOf('<section class="pane" id="pane-' + name + '"');
  if (i < 0) return '';
  const j = src.indexOf('</section>', i);
  return src.slice(i, j < 0 ? i + 4000 : j);
};
for (const name of panes) {
  const h = paneHtml(name);
  const hasSave = /data-save="/.test(h) || (dedicated[name] || []).some((id) => h.includes('id="' + id + '"'));
  ok(hasSave, 'pane ' + name + ' 有保存/执行入口', (dedicated[name] || []).join('/') || 'data-save');
}

console.log('\n== C. data-save 的 section 都合法 ==');
// nav / qa 有专用接口（/api/nav、/api/qa），不走 /api/site 的 SITE_SECTIONS
const SPECIAL_SAVE = { nav: '/api/nav', qa: '/api/qa' };
const saves = [...src.matchAll(/data-save="([a-z]+)"/g)].map((m) => m[1]);
for (const s of [...new Set(saves)]) {
  if (SPECIAL_SAVE[s]) {
    ok(src.includes(SPECIAL_SAVE[s]), 'data-save="' + s + '" 走专用接口 ' + SPECIAL_SAVE[s]);
  } else {
    ok(secs.includes(s), 'data-save="' + s + '" 在 SITE_SECTIONS 里');
  }
}

console.log('\n== D. 每个输入框都有人读 ==');
const idsInPanes = new Set();
for (const name of panes) {
  for (const m of paneHtml(name).matchAll(/<(?:input|textarea|select)[^>]*id="([A-Za-z][\w-]*)"/g)) idsInPanes.add(m[1]);
}
const dynamicRead = /querySelectorAll\('\[data-/.test(src) || /data-ad-slot/.test(src);
// 动态读：FIELDS[sec].forEach(k => $(sec + '-' + k))；[data-vf] 选择器；readonly 展示框
const fieldsM = src.match(/var FIELDS = \{([\s\S]*?)\n  \};/);
const dynPrefix = fieldsM ? secs.map((s) => s + '-') : [];
const readonlyIds = new Set();
for (const name of panes) {
  for (const m of paneHtml(name).matchAll(/<(?:input|textarea|select)\b[^>]*>/g)) {
    const tag = m[0];
    const idm = tag.match(/\bid="([A-Za-z][\w-]*)"/);
    if (idm && /\breadonly\b/.test(tag)) readonlyIds.add(idm[1]);
  }
}
const skipped = [];
for (const id of idsInPanes) {
  const read = src.includes("$('" + id + "')") || src.includes('$("' + id + '")');
  if (read) continue;
  if (dynPrefix.some((p) => id.startsWith(p))) { skipped.push(id + '(FIELDS)'); continue; }
  if (/^vf[A-Z]/.test(id)) { skipped.push(id + '(data-vf)'); continue; }
  if (readonlyIds.has(id)) { skipped.push(id + '(readonly)'); continue; }
  ok(false, '输入框 ' + id + ' 没人读（写进去也存不下来）');
}
console.log('  动态/只读跳过 ' + skipped.length + ' 个：' + skipped.join(' '));
ok(true, '共检查 ' + idsInPanes.size + ' 个输入框（dynamic=' + dynamicRead + '）');

console.log(fail === 0 ? '\n全部通过' : '\n' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
