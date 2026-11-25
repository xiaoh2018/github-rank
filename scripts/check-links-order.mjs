// 友链排序（move）+ 导航空态 门禁。需要先起 dev-server（8123）。
const base = process.env.BASE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PASSWORD || 'dev';
const A = '__gate__友链A';
const B = '__gate__友链B';
let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

const post = async (body) => {
  const r = await fetch(base + '/api/links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ password: PW }, body)) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const list = async () => {
  const r = await fetch(base + '/api/links?v=' + Date.now());
  const j = await r.json().catch(() => ({}));
  return j.links || [];
};
const idxOf = (l, name) => l.findIndex((x) => x && x.name === name);

const cleanup = async () => {
  for (const n of [A, B]) {
    let l = await list();
    let i = idxOf(l, n);
    let guard = 0;
    while (i >= 0 && guard++ < 5) { await post({ action: 'remove', index: i }); l = await list(); i = idxOf(l, n); }
  }
};

await cleanup();

console.log('== 1. 加两条友链 ==');
let r = await post({ action: 'add', name: A, url: 'https://example.com/a', desc: '' });
ok('添加 A 200', r.status === 200, r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
r = await post({ action: 'add', name: B, url: 'https://example.com/b', desc: '' });
ok('添加 B 200', r.status === 200, r.status);

let l = await list();
const iA = idxOf(l, A), iB = idxOf(l, B);
ok('两条都在列表里', iA >= 0 && iB >= 0, 'A=' + iA + ' B=' + iB);

console.log('== 2. 上移 / 下移 ==');
r = await post({ action: 'move', from: iB, to: 0 });
ok('move 200', r.status === 200, r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
l = await list();
ok('B 被移到第一位', (l[0] || {}).name === B, (l[0] || {}).name);

r = await post({ action: 'move', from: 0, to: l.length - 1 });
ok('move 到底部 200', r.status === 200, r.status);
l = await list();
ok('B 现在在最后', (l[l.length - 1] || {}).name === B, (l[l.length - 1] || {}).name);

console.log('== 3. 越界要拒绝 ==');
r = await post({ action: 'move', from: 0, to: 999 });
ok('to 越界 400', r.status === 400, r.status + ' ' + JSON.stringify(r.json).slice(0, 100));
r = await post({ action: 'move', from: -1, to: 0 });
ok('from 负数 400', r.status === 400, r.status);

console.log('== 4. 非法 action ==');
r = await post({ action: 'swapall', from: 0, to: 1 });
ok('未知 action 400', r.status === 400, r.status);

console.log('== 5. 清理 ==');
await cleanup();
l = await list();
ok('测试友链已删除', idxOf(l, A) < 0 && idxOf(l, B) < 0, JSON.stringify(l.map((x) => x && x.name)));

console.log('== 6. 前台/后台代码在位 ==');
const fs = await import('node:fs');
const idx = fs.readFileSync('index.html', 'utf8');
const adm = fs.readFileSync('worker.js', 'utf8');
ok('导航页有「还没有站点」空态', idx.includes('导航页还没有站点'), '');
ok('搜索无结果提示带清空提示', idx.includes('清空搜索框可看全部'), '');
ok('后台友链行有上移按钮', adm.includes('data-up='), '');
ok('后台友链行有下移按钮', adm.includes('data-down='), '');
ok('后台点按钮会调 move', adm.includes("action: 'move'"), '');

console.log(fails ? `友链排序门禁 ${fails} 项失败` : '友链排序门禁全部通过');
process.exit(fails ? 1 : 0);
