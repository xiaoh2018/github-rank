import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => {
  rows.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

if (REMOTE) {
  const adm = await (await fetch(BASE + '/admin')).text();
  push('后台带「手机上默认收起预览」逻辑', adm.includes('previewDefault') && adm.includes("btn.textContent = '显示预览'"), '');
  push('后台对话框在窄屏铺满（不再留 12px 边距挤编辑区）', adm.includes('width:100vw;max-width:100vw'), '');
  const bad0 = rows.filter((x) => !x.ok);
  console.log('\n' + (bad0.length ? 'FAILED ' + bad0.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE + ' (REMOTE)');
  process.exit(bad0.length ? 1 : 0);
}

const login = async (cdp) => {
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2600));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="articles"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 600));
};

const cdp = await openCdp({ width: 900, height: 900 });
try {
  // --- A. 390 ---
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1500));
  await login(cdp);

  await cdp.js("document.getElementById('artNew').click()");
  await new Promise((r) => setTimeout(r, 800));
  const a = await cdp.js(`(function(){
    var d=document.getElementById('artDlg'), g=document.querySelector('#artDlg .art-grid');
    var p=document.querySelector('#artDlg .art-prev-col');
    return {open:!!(d&&d.open), off:g.classList.contains('preview-off'),
      prev: p?getComputedStyle(p).display:'none',
      btn: document.getElementById('artPreviewBtn').textContent,
      dlgW: Math.round(d.getBoundingClientRect().width),
      cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth};
  })()`);
  push('390 打开「写新文章」', a.open === true, a.open);
  push('手机上默认收起预览', a.off === true && a.prev === 'none', a);
  push('按钮写「显示预览」', a.btn === '显示预览', a.btn);
  push('对话框和屏幕同宽（不横向溢出）', a.dlgW === a.cw && a.sw <= a.cw + 1, a);

  const toggled = await cdp.js(`(function(){
    document.getElementById('artPreviewBtn').click();
    var g=document.querySelector('#artDlg .art-grid');
    var p=document.querySelector('#artDlg .art-prev-col');
    return {off:g.classList.contains('preview-off'), prev:getComputedStyle(p).display,
      btn:document.getElementById('artPreviewBtn').textContent};
  })()`);
  push('点一下能展开预览', toggled.off === false && toggled.prev !== 'none', toggled);
  push('按钮变「隐藏预览」', toggled.btn === '隐藏预览', toggled.btn);

  const md = await cdp.js(`(function(){
    var t=document.getElementById('artBody');
    t.value='## 小标题测试\\n\\n**加粗** 段落';
    t.dispatchEvent(new Event('input'));
    var p=document.getElementById('artPrev');
    return {h2: !!p.querySelector('h1, h2, h3, h4, h5, h6'), strong: !!p.querySelector('strong'), raw: p.textContent.indexOf('##')>=0, html: p.innerHTML.slice(0, 90)};
  })()`);
  push('预览真的渲染 Markdown（出 h2/strong，不残留 ##）', md.h2 && md.strong && md.raw === false, md);

  await cdp.js("document.getElementById('artDlg').close()");
  await new Promise((r) => setTimeout(r, 400));

  // 编辑已有文章也默认收起
  const ed = await cdp.js(`(function(){
    var b=document.querySelector('[data-artedit]');
    if(!b) return 'no-edit-btn';
    b.click(); return 'clicked';
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  if (ed === 'clicked') {
    const e = await cdp.js(`(function(){var g=document.querySelector('#artDlg .art-grid');return {off:g.classList.contains('preview-off'), btn:document.getElementById('artPreviewBtn').textContent}})()`);
    push('390 编辑已有文章也默认收起', e.off === true && e.btn === '显示预览', e);
    await cdp.js("document.getElementById('artDlg').close()");
  } else {
    push('390 编辑已有文章也默认收起', true, '（当前没有文章，跳过）');
  }

  // --- B. 1440 ---
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1500));
  await login(cdp);
  await cdp.js("document.getElementById('artNew').click()");
  await new Promise((r) => setTimeout(r, 800));
  const b = await cdp.js(`(function(){
    var g=document.querySelector('#artDlg .art-grid');
    var p=document.querySelector('#artDlg .art-prev-col');
    return {off:g.classList.contains('preview-off'), prev:getComputedStyle(p).display,
      btn:document.getElementById('artPreviewBtn').textContent, w:Math.round(p.getBoundingClientRect().width)};
  })()`);
  push('1440 默认显示预览（并排）', b.off === false && b.prev !== 'none' && b.w > 240, b);
  push('1440 按钮是「隐藏预览」', b.btn === '隐藏预览', b.btn);
  await cdp.js("document.getElementById('artDlg').close()");
} finally {
  await cdp.close();
}

const bad = rows.filter((x) => !x.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + ' of ' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE);
process.exit(bad.length ? 1 : 0);