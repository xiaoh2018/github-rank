const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const st = await (await fetch(BASE + '/api/status')).json();
  const auth = await fetch(BASE + '/admin');
  const adm = await auth.text();
  push('后台有「草稿」勾选框', adm.includes('id="artDraft"') && adm.includes('草稿（不在前台显示）'));
  push('后台列表有草稿徽章', adm.includes('draft-badge'));
  finish();
}

const post = async (body) => {
  const r = await fetch(BASE + '/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ password: 'dev' }, body)),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const title = '草稿门禁-' + Date.now();
const add = await post({ action: 'add', article: { title, date: '2026-11-29', summary: '', body: '', draft: true } });
push('可以保存一篇「只有标题的草稿」', add.status === 200 && add.json.ok === true, add.status + ' ' + JSON.stringify(add.json).slice(0, 120));
const made = (add.json.articles || []).find((a) => a.title === title);
push('保存后带 draft: true', !!made && made.draft === true, made ? JSON.stringify({ draft: made.draft, slug: made.slug }) : 'not found');
const slug = made ? (made.slug || made.id) : '';

const pubRes = await fetch(BASE + '/data/articles.json?v=' + Date.now());
const pub = await pubRes.json().catch(() => []);
const pubHit = Array.isArray(pub) ? pub.some((a) => a.title === title) : true;
push('前台数据文件里看不到草稿', Array.isArray(pub) && !pubHit, 'count=' + (Array.isArray(pub) ? pub.length : 'n/a'));

const adminList = await fetch(BASE + '/api/articles').then((r) => r.json());
const adminHit = (adminList.articles || []).find((a) => a.title === title);
push('后台接口里能看到草稿（带 draft 标记）', !!adminHit && adminHit.draft === true, adminHit ? 'draft=' + adminHit.draft : 'missing');

const sitemap = await fetch(BASE + '/sitemap.xml').then((r) => r.text());
push('站点地图不收录草稿', slug ? !sitemap.includes(slug) : false, slug);

const bad = await post({ action: 'add', article: { title: title + '-非草稿', date: '2026-11-29', summary: '', body: '', draft: false } });
push('非草稿仍然要求有正文', bad.status === 400 && /正文是空的/.test((bad.json || {}).error || ''), bad.status + ' ' + JSON.stringify(bad.json).slice(0, 90));

if (made) {
  const del = await post({ action: 'remove', id: made.id });
  push('清理测试草稿', del.status === 200 && del.json.ok === true, del.status);
  const after = await fetch(BASE + '/api/articles').then((r) => r.json());
  push('清理后后台也看不到它', !(after.articles || []).some((a) => a.title === title));
}

const adm = await (await fetch(BASE + '/admin')).text();
push('后台编辑弹窗有草稿勾选框', adm.includes('id="artDraft"'));
push('后台列表有草稿徽章样式', adm.includes('draft-badge'));
finish();

function finish() {
  let fail = 0;
  for (const r of rows) {
    if (!r.ok) fail++;
    console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + r.detail : ''));
  }
  console.log('');
  console.log(fail ? fail + ' FAILED of ' + rows.length : 'ALL OK (' + rows.length + ')  @' + BASE + (REMOTE ? ' (REMOTE)' : ''));
  process.exit(fail ? 1 : 0);
}