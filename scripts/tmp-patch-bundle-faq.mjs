import fs from 'node:fs';
const F = 'js/bundle.js';
const raw = fs.readFileSync(F, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

const find = `  // page=nav / page=articles 是「哪个视图」的地址标记（不是榜单的 view 参数），同步地址时必须原样保留，
  // 否则刷新/分享会掉回榜单
  const pageMark = new URLSearchParams(location.search).get('page');
  if (pageMark === 'nav' || pageMark === 'articles') sp.set('page', pageMark);`;
const repl = `  // page=nav / page=articles / page=faq 是「哪个视图」的地址标记（不是榜单的 view 参数），同步地址时必须原样保留，
  // 否则刷新/分享会掉回榜单
  const pageMark = new URLSearchParams(location.search).get('page');
  if (pageMark === 'nav' || pageMark === 'articles' || pageMark === 'faq') sp.set('page', pageMark);`;

const n = s.split(find).length - 1;
if (n !== 1) throw new Error(`命中 ${n} 次，期望 1`);
s = s.split(find).join(repl);
if (crlf) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(F, s, 'utf8');
console.log('bundle pageMark ok');
