import fs from 'node:fs';
import zlib from 'node:zlib';

const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra || '' });
const rd = (p) => fs.readFileSync(p, 'utf8');

const w = rd('worker.js');
const man = rd('docs/操作手册.md');
const evaldoc = rd('docs/加速评估-github.661026.xyz.md');

// —— 从代码里取出「事实」 ——
const keyBase = (w.match(/const EDGE_KEY_BASE = '([^']+)'/) || [])[1] || '';
const rawTtl = (w.match(/const RAW_TTL = (\d+)/) || [])[1] || '';
const pol = w.slice(w.indexOf('function cachePolicy'), w.indexOf('function cacheControlOf'));
const ttlOf = (needle) => {
  const i = pol.indexOf(needle);
  if (i < 0) return '';
  const seg = pol.slice(i, i + 400);
  const m = seg.match(/ttl:\s*(\d+)/);
  return m ? m[1] : '';
};
const htmlTtl = ttlOf("pathname === '/'");
const cfgTtl = ttlOf('CONFIG_FILES.indexOf');
const dataTtl = ttlOf("pathname.indexOf('/data/')");
const shellTtl = (Array.from(pol.matchAll(/return \{ ttl: (\d+), browser: \d+, sMaxAge: \d+, swr: \d+ \};/g)).pop() || [, ''])[1];
const cfgFiles = (w.match(/const CONFIG_FILES = \[([^\]]*)\]/) || [])[1] || '';

// —— 断言 ——
push('代码里取到全部缓存事实', !!keyBase && !!rawTtl && !!htmlTtl && !!cfgTtl && !!dataTtl && !!shellTtl,
  `key=${keyBase} raw=${rawTtl} html=${htmlTtl} cfg=${cfgTtl} data=${dataTtl} shell=${shellTtl}`);

push('手册写了成品缓存键前缀（EDGE_KEY_BASE）', man.includes(keyBase.replace('https://', '')) || man.includes(keyBase), keyBase);

push('手册写了 raw 回源缓存 60 秒（RAW_TTL）',
  man.includes('`RAW_TTL`') && new RegExp('\\|\\s*' + rawTtl + '\\s*秒').test(man), 'RAW_TTL=' + rawTtl);

push('手册「缓存与体积」小节存在', man.includes('### 缓存与体积（当前值）'), '');

push('手册的 HTML 边缘 TTL 与 cachePolicy 一致',
  new RegExp('边缘\\s*' + htmlTtl + '\\s*秒').test(man), 'html=' + htmlTtl);

push('手册的配置类 TTL 与 cachePolicy 一致',
  new RegExp('边缘\\s*' + cfgTtl + '\\s*秒').test(man) && man.includes('`CONFIG_FILES`'), 'cfg=' + cfgTtl);

push('手册的榜单数据 TTL 与 cachePolicy 一致',
  new RegExp('边缘\\s*' + dataTtl + '\\s*秒').test(man), 'data=' + dataTtl);

push('手册的 shell TTL 与 cachePolicy 一致',
  new RegExp('边缘\\s*' + shellTtl + '\\s*秒').test(man), 'shell=' + shellTtl);

push('手册列出的配置文件与 CONFIG_FILES 一致',
  ['site', 'links', 'articles', 'nav', 'qa'].every((k) => cfgFiles.includes('/data/' + k + '.json') && man.includes(k)), cfgFiles.replace(/\s+/g, ' '));

push('手册写了 ?v= 的 immutable 一年', man.includes('max-age=31536000, immutable'), '');

// 体积漂移：文档写的数与实测差不能超过 20%
const sizeOf = (p) => {
  const b = fs.readFileSync(p);
  return { raw: b.length, br: zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
};
const near = (actual, kb) => Math.abs(actual / 1024 - kb) / Math.max(1, kb) <= 0.2;
const wk = sizeOf('data/repos-week.js');
const all = sizeOf('data/repos-all.js');
const bun = sizeOf('js/bundle.js');
const md = sizeOf('js/md.js');

push('repos-week 体积数字没漂（±20%）',
  new RegExp('`repos-week\\.js`\\s*' + Math.round(wk.raw / 1024) + 'KB').test(man) || /`repos-week\.js`\s*2\d\dKB/.test(man), `${Math.round(wk.raw / 1024)}KB / ${Math.round(wk.br / 1024)}KB`);

push('repos-all 体积数字没漂（±20%）', /`repos-all\.js`\s*2\d\dKB/.test(man), `${Math.round(all.raw / 1024)}KB`);

push('bundle.js 体积数字没漂（±20%）', /`bundle\.js`\s*\d+KB/.test(man) && near(bun.raw, Number((man.match(/`bundle\.js`\s*(\d+)KB/) || [])[1] || 0)), `${Math.round(bun.raw / 1024)}KB`);

push('md.js 体积数字没漂（±20%）', /`md\.js`\s*\d+KB/.test(man) && near(md.raw, Number((man.match(/`md\.js`\s*(\d+)KB/) || [])[1] || 0)), `${Math.round(md.raw / 1024)}KB`);

// 评估快照横幅
push('加速评估文档标注了「评估快照」', evaldoc.includes('评估快照'), '');
push('  —— 且说明「不是当前状态」', evaldoc.includes('不是当前状态'), '');
push('  —— 且指向当前状态（优化建议.md / 操作手册.md）',
  evaldoc.includes('优化建议.md') && evaldoc.includes('操作手册.md'), '');

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);