import fs from 'node:fs';

function patch(file, ops) {
  let t = fs.readFileSync(file, 'utf8');
  const crlf = t.indexOf('\r\n') >= 0;
  if (crlf) t = t.split('\r\n').join('\n');
  for (const [name, find, repl] of ops) {
    const n = t.split(find).length - 1;
    if (n !== 1) throw new Error(file + ' :: ' + name + ' matched ' + n);
    t = t.replace(find, repl);
  }
  fs.writeFileSync(file, crlf ? t.split('\n').join('\r\n') : t, 'utf8');
  console.log('patched', file, ops.length);
}

const css = `  .serp{margin-top:6px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
  .serp-t{font-size:17px;line-height:1.35;color:#1a0dab;font-weight:500;margin-bottom:2px}
  .serp-u{font-size:12.5px;color:#15803d;margin-bottom:4px;word-break:break-all}
  .serp-d{font-size:13px;line-height:1.6;color:#4b5563}
  .cnow{margin-top:4px;font-size:12px;color:#64748b}
  .cnow.cwarn{color:#b91c1c}
  .tr-out{`;

const html = `        <div class="actions"><button type="button" data-save="seo">保存 SEO 设置</button></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>搜索结果长这样</h2><p class="desc">左边填的东西会决定这段预览。蓝色是标题（60 字内不截断），绿色是网址，灰色是描述（160 字内不截断）。</p></div></div>
        <div class="serp">
          <div class="serp-t" id="serpTitle">GitHub 热门项目排行榜</div>
          <div class="serp-u" id="serpUrl">github.661026.xyz</div>
          <div class="serp-d" id="serpDesc">（这里会显示页面描述，建议 80–120 字）</div>
        </div>
        <div class="cnow" id="serpTitleCnt">—</div>
        <div class="cnow" id="serpDescCnt">—</div>
      </div>`;

const js = `  function paintSerp() {
    var tEl = $('seo-title'), dEl = $('seo-description'), uEl = $('seo-siteUrl'), nEl = $('seo-siteName');
    if (!tEl || !dEl) return;
    function esc(x) {
      return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    var title = (tEl.value || (nEl && nEl.value) || 'GitHub 热门项目排行榜').trim();
    var desc = (dEl.value || '').trim();
    var url = ((uEl && uEl.value) || location.origin || '').trim();
    while (url.slice(-1) === '/') url = url.slice(0, -1);
    var shown = url.indexOf('https://') === 0 ? url.slice(8) : url.indexOf('http://') === 0 ? url.slice(7) : url;
    var tBox = $('serpTitle'), uBox = $('serpUrl'), dBox = $('serpDesc');
    if (tBox) tBox.textContent = title.length > 60 ? title.slice(0, 60) + '…' : title;
    if (uBox) uBox.textContent = shown || 'github.661026.xyz';
    if (dBox) dBox.textContent = desc ? (desc.length > 160 ? desc.slice(0, 160) + '…' : desc) : '（这里会显示页面描述，建议 80–120 字）';
    var tc = $('serpTitleCnt'), dc = $('serpDescCnt');
    if (tc) {
      tc.textContent = '标题 ' + title.length + ' 字 · ' + (title.length > 60 ? '超过 60 字会被截断' : title.length > 30 ? '略长，建议 30 字内' : '长度合适');
      tc.className = 'cnow' + (title.length > 60 ? ' cwarn' : '');
    }
    if (dc) {
      dc.textContent = '描述 ' + desc.length + ' 字 · ' + (desc.length > 160 ? '超过 160 字会被截断' : desc.length === 0 ? '还没填' : desc.length < 60 ? '偏短，建议 80–120 字' : '长度合适');
      dc.className = 'cnow' + (desc.length > 160 ? ' cwarn' : '');
    }
  }
  ['seo-title', 'seo-description', 'seo-siteUrl', 'seo-siteName'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', paintSerp);
  });
  function loadSite() {`;

patch('worker.js', [
  ['css-serp', '  .tr-out{', css],
  ['html-serp', '        <div class="actions"><button type="button" data-save="seo">保存 SEO 设置</button></div>\n      </div>', html],
  ['js-paint', '  function loadSite() {', js],
  ['js-hook', '      fillSite(r.site);', '      fillSite(r.site);\n      paintSerp();'],
]);
