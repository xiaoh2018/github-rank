import fs from 'node:fs';

function patch(file, ops) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = /\r\n/.test(raw);
  let s = raw.replace(/\r\n/g, '\n');
  for (const [label, find, repl] of ops) {
    const n = s.split(find).length - 1;
    if (n !== 1) throw new Error(file + ' [' + label + '] hits=' + n);
    s = s.replace(find, () => repl);
    console.log('ok ' + label);
  }
  fs.writeFileSync(file, crlf ? s.split('\n').join('\r\n') : s, 'utf8');
}

const themePane = `  <section class="pane" id="pane-theme" hidden>
    <div class="bar"><div><h1>主题</h1><div class="sub">内置 4 套配色，前台用同一套；访客可以用太阳 / 月亮按钮切明暗</div></div>
      <button type="button" data-save="theme">保存主题</button></div>
    <div class="intro">这里选的是「默认主题」：新访客第一次打开看到的颜色。访客自己换过之后，浏览器会记住他的选择，不再覆盖。<b>明暗</b>（浅色 / 深色）是另一维度，前台右上角那个太阳 / 月亮按钮就是它。</div>
    <div class="card">
      <div class="card-head"><b>默认主题</b><span class="hint">点卡片切换，右边是这套配色的实际样子</span></div>
      <div class="choice-grid theme-grid" data-theme-group>
        <label class="choice theme-choice" data-t="paper">
          <input type="radio" name="theme-name" value="paper">
          <span class="theme-t">暖纸 + 金<b>默认</b></span>
          <span class="theme-swatch sw-paper"><i></i><i></i><i></i><i></i></span>
        </label>
        <label class="choice theme-choice" data-t="ink">
          <input type="radio" name="theme-name" value="ink">
          <span class="theme-t">墨白 + 黑</span>
          <span class="theme-swatch sw-ink"><i></i><i></i><i></i><i></i></span>
        </label>
        <label class="choice theme-choice" data-t="slate">
          <input type="radio" name="theme-name" value="slate">
          <span class="theme-t">石墨 + 蓝</span>
          <span class="theme-swatch sw-slate"><i></i><i></i><i></i><i></i></span>
        </label>
        <label class="choice theme-choice" data-t="forest">
          <input type="radio" name="theme-name" value="forest">
          <span class="theme-t">纸白 + 松绿</span>
          <span class="theme-swatch sw-forest"><i></i><i></i><i></i><i></i></span>
        </label>
      </div>
      <label class="toggle inline" style="margin-top:14px"><input type="checkbox" id="theme-allow"> 允许访客在前端自己换主题</label>
      <p class="hint">关掉之后，前台只显示太阳 / 月亮（明暗）按钮，不显示配色选择。</p>
    </div>
    <div class="card">
      <div class="card-head"><b>预览</b><span class="hint">用当前选中的配色 + 明暗渲染一块假页面</span></div>
      <div class="theme-preview" id="themePreview" data-mode="light"></div>
    </div>
  </section>

`;

const themeCss = `.theme-grid{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.theme-choice{padding:12px 14px}
.theme-choice .theme-t{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--text)}
.theme-choice .theme-t b{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:5px;background:#eef2f7;color:#5b6675}
.theme-swatch{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:8px}
.theme-swatch i{height:22px;border-radius:5px;display:block}
.sw-paper i:nth-child(1){background:#faf7f0}.sw-paper i:nth-child(2){background:#fff;border:1px solid #e5e0d4}.sw-paper i:nth-child(3){background:#1c2230}.sw-paper i:nth-child(4){background:#b07d10}
.sw-ink i:nth-child(1){background:#f7f7f7}.sw-ink i:nth-child(2){background:#fff;border:1px solid #e6e6e6}.sw-ink i:nth-child(3){background:#111}.sw-ink i:nth-child(4){background:#111}
.sw-slate i:nth-child(1){background:#f4f6f9}.sw-slate i:nth-child(2){background:#fff;border:1px solid #e2e8f0}.sw-slate i:nth-child(3){background:#141a22}.sw-slate i:nth-child(4){background:#2f6feb}
.sw-forest i:nth-child(1){background:#f4f7f2}.sw-forest i:nth-child(2){background:#fff;border:1px solid #e0e7dc}.sw-forest i:nth-child(3){background:#152018}.sw-forest i:nth-child(4){background:#2f7a4f}
.theme-preview{border:1px solid var(--line);border-radius:12px;overflow:hidden}
.theme-preview[data-t="paper"]{--pbg:#faf7f0;--pcard:#fff;--ptext:#1c2230;--pmuted:#6b7280;--pline:#e5e0d4;--pacc:#b07d10}
.theme-preview[data-t="ink"]{--pbg:#f7f7f7;--pcard:#fff;--ptext:#111;--pmuted:#6b6b6b;--pline:#e6e6e6;--pacc:#111}
.theme-preview[data-t="slate"]{--pbg:#f4f6f9;--pcard:#fff;--ptext:#141a22;--pmuted:#5f6b7a;--pline:#e2e8f0;--pacc:#2f6feb}
.theme-preview[data-t="forest"]{--pbg:#f4f7f2;--pcard:#fff;--ptext:#152018;--pmuted:#5e6b60;--pline:#e0e7dc;--pacc:#2f7a4f}
.theme-preview[data-mode="dark"]{--pbg:#0b0d10;--pcard:#14171b;--ptext:#e8eaed;--pmuted:#9aa3ad;--pline:#22262b;--pacc:#c9a227}
.theme-preview[data-t="slate"][data-mode="dark"]{--pacc:#5b8def}
.theme-preview[data-t="forest"][data-mode="dark"]{--pacc:#4faf7c}
.theme-preview .tp-page{background:var(--pbg);padding:16px;color:var(--ptext)}
.theme-preview .tp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;font-size:12px;color:var(--pmuted)}
.theme-preview .tp-brand{font-weight:700;color:var(--ptext);font-size:14px}
.theme-preview .tp-card{background:var(--pcard);border:1px solid var(--pline);border-radius:10px;padding:12px;margin-bottom:8px}
.theme-preview .tp-card b{font-size:13px}
.theme-preview .tp-card p{margin:4px 0 0;font-size:11.5px;color:var(--pmuted)}
.theme-preview .tp-btn{display:inline-block;margin-top:8px;padding:5px 10px;border-radius:7px;background:var(--pacc);color:#fff;font-size:11px;font-weight:600}
.theme-preview[data-t="ink"] .tp-btn{color:#fff}
`;

patch('worker.js', [
  // 主题常量
  ['themes-const', `const NAV_FILE = 'data/nav.json';`,
`const NAV_FILE = 'data/nav.json';
const THEMES = ['paper', 'ink', 'slate', 'forest'];
const FAVICON = (host) => 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(host);`],

  // defaultSite 主题
  ['default-theme', `    layout: { mode: 'auto', side: 'right', users: 'auto', articleSide: 'right' },`,
`    layout: { mode: 'auto', side: 'right', users: 'auto', articleSide: 'right' },
    theme: { name: 'paper', allowUser: true },`],

  // normalizeSite 主题
  ['normalize-theme', `  const lo = o && typeof o.layout === 'object' && o.layout ? o.layout : {};`,
`  const lo = o && typeof o.layout === 'object' && o.layout ? o.layout : {};
  const th = o && typeof o.theme === 'object' && o.theme ? o.theme : {};
  d.theme = {
    name: THEMES.indexOf(String(th.name || '')) >= 0 ? String(th.name) : 'paper',
    allowUser: th.allowUser !== false
  };`],

  ['check-theme', `  if (section === 'layout') {`,
`  if (section === 'theme') {
    const v = value && typeof value === 'object' ? value : {};
    const nm = String(v.name == null ? '' : v.name);
    if (THEMES.indexOf(nm) < 0) return { ok: false, error: '主题只能是 paper、ink、slate 或 forest' };
    return { ok: true, value: { name: nm, allowUser: v.allowUser !== false } };
  }
  if (name === 'layout') {`],

  // 面板
  ['pane-theme', `  <section class="pane" id="pane-articles" hidden>`, themePane + `  <section class="pane" id="pane-articles" hidden>`],

  // CSS
  ['css-theme', `::-webkit-scrollbar-thumb{background:#d6d3cc;`, themeCss + `::-webkit-scrollbar-thumb{background:#d6d3cc;`],

  // 导航/侧栏入口
  ['nav-theme', `      <button type="button" class="nav" data-tab="articles">文章<span class="nav-badge" id="navArtCount" hidden>0</span></button>`,
`      <button type="button" class="nav" data-tab="articles">文章<span class="nav-badge" id="navArtCount" hidden>0</span></button>
      <button type="button" class="nav" data-tab="theme">主题</button>`],

  ['tabs-theme', `  var TABS = ['overview', 'layout', 'articles', 'nav', 'seo', 'links', 'ad', 'contact', 'beian', 'submit', 'keys', 'translate'];`,
`  var TABS = ['overview', 'layout', 'theme', 'articles', 'nav', 'seo', 'links', 'ad', 'contact', 'beian', 'submit', 'keys', 'translate'];`],

  // 字段定义
  ['fields-theme', `    layout: ['mode', 'side', 'users'],`,
`    layout: ['mode', 'side', 'users'],
    theme: ['name', 'allowUser'],`],

  // fillSite 回填主题
  ['fill-theme', `    picked['layout-mode'] = lay.mode || 'auto';`,
`    var th = (s && s.theme) || {};
    Array.prototype.forEach.call(document.querySelectorAll('input[name="theme-name"]'), function (r) {
      r.checked = r.value === (th.name || 'paper');
    });
    if ($('theme-allow')) $('theme-allow').checked = th.allowUser !== false;
    paintThemePreview();
    picked['layout-mode'] = lay.mode || 'auto';`],

  // 主题交互 + 预览
  ['theme-js', `  function askConfirm(title, note, fn) {`,
`  function paintThemePreview() {
    var box = $('themePreview');
    if (!box) return;
    var on = document.querySelector('input[name="theme-name"]:checked');
    var t = on ? on.value : 'paper';
    var dark = matchMedia('(prefers-color-scheme: dark)').matches;
    box.setAttribute('data-t', t);
    box.setAttribute('data-mode', dark ? 'dark' : 'light');
    box.innerHTML = '<div class="tp-page"><div class="tp-head"><span class="tp-brand">GitHub 热门项目排行榜</span>' +
      '<span>榜单 · 导航 · 文章</span></div>' +
      '<div class="tp-card"><b>codecrafters-io/build-your-own-x</b><p>565.3k ★ · TypeScript · 今天的第 1 名</p>' +
      '<span class="tp-btn">看详情</span></div>' +
      '<div class="tp-card"><b>sindresorhus/awesome</b><p>542.3k ★ · Markdown</p></div>' +
      '<div class="tp-card"><b>这是卡片正文的灰色说明文字</b><p>配色换一下就能看出差别：底色、卡片、文字、强调色。</p></div></div>';
  }
  document.addEventListener('change', function (e) {
    if (e.target && e.target.name === 'theme-name') paintThemePreview();
  });

  function askConfirm(title, note, fn) {`],

  // 抓描述时补 favicon
  ['fetchmeta-icon', `    const icon = pickIcon(html, u);`,
`    const icon = pickIcon(html, u) || FAVICON(u.hostname);`],
]);

patch('data/nav.json', [
  ['nav-icons-1', `"icon": "https://chat.openai.com/favicon.ico"`, `"icon": "https://www.google.com/s2/favicons?sz=64&domain=chatgpt.com"`],
]);
console.log('done');
