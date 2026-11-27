// 把 data/ 下由 Action 生成的文件同步成远端最新（本地常年落后，rest-push 只推我自己改的文件）
import fs from 'node:fs';

const REPO = 'xiaoh2018/github-rank';
const BRANCH = 'main';
const FILES = [
  'data/repos.js', 'data/repos-meta.js', 'data/repos-week.js', 'data/repos-month.js',
  'data/repos-year.js', 'data/repos-total.js', 'data/repos-all.js',
  'data/desc-zh.json', 'data/readme-zh.json',
];

const meta = (txt) => {
  const m = String(txt).match(/generatedAt:\s*"([^"]+)"/);
  return m ? m[1] : '';
};
const bytes = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + 'K' : n + 'B');

let changed = 0;
let failed = 0;
for (const f of FILES) {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${f}?cb=${Date.now()}`;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) { console.log('FAIL', f, 'HTTP ' + r.status); failed++; continue; }
    const text = await r.text();
    if (!text || text.length < 32) { console.log('FAIL', f, '内容过短'); failed++; continue; }
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (old === text) { console.log('same', f, bytes(text.length)); continue; }
    fs.writeFileSync(f, text, 'utf8');
    changed++;
    const a = meta(old);
    const b = meta(text);
    console.log('sync', f, bytes(old.length) + ' -> ' + bytes(text.length), a && b ? a + ' -> ' + b : '');
  } catch (e) {
    console.log('FAIL', f, e.message);
    failed++;
  }
}
console.log(`--- 同步完成：更新 ${changed} 个，失败 ${failed} 个`);
if (failed) process.exit(1);