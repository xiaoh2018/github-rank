// 生成后台各面板的静态预览页（跳过登录门），用于本机截图核对 UI
// 用法：node scripts/preview-admin.mjs  → 写到 %TEMP%\ghrank-preview\*.html
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = path.join(os.tmpdir(), 'ghrank-preview');
fs.mkdirSync(out, { recursive: true });

const res = await fetch('http://127.0.0.1:8123/admin');
if (!res.ok) throw new Error('取 /admin 失败：' + res.status);
const html = await res.text();

const panes = ['overview', 'layout', 'articles', 'seo', 'translate'];
for (const p of panes) {
  const inject = `<script>
window.addEventListener('load', function(){
  document.getElementById('gate').style.display='none';
  var app=document.getElementById('app'); app.hidden=false;
  try{ enter(); }catch(e){}
  var btn=document.querySelector('.nav[data-tab="${p}"]');
  if(btn) btn.click();
});
</script>`;
  const file = path.join(out, 'admin-' + p + '.html');
  fs.writeFileSync(file, html.replace('</body>', inject + '\n</body>'), 'utf8');
  console.log(file);
}

// 文章弹窗放大后的样子
const dlg = `<script>
window.addEventListener('load', function(){
  document.getElementById('gate').style.display='none';
  var app=document.getElementById('app'); app.hidden=false;
  try{ enter(); }catch(e){}
  var navBtn=document.querySelector('.nav[data-tab="articles"]'); if(navBtn) navBtn.click();
  try{
    document.getElementById('artTitleIn').value='示例：用 Cloudflare Workers 做一个只读排行榜';
    document.getElementById('artDate').value='2026-11-25';
    document.getElementById('artSummary').value='这一篇演示写文章弹窗放大后的排版：左边写、右边实时预览。';
    document.getElementById('artBody').value='## 为什么要静态化\\n\\nGitHub API 有速率限制，访客一多就 403。把榜单数据每天跑一次写进仓库，前端直接读静态文件，成本几乎为零。\\n\\n- 数据：Action 每 3 小时抓一次\\n- 边缘：Worker 缓存成品响应\\n- 前端：按需加载单个时间范围\\n\\n> 这套组合拳在免费额度内就能撑住日常流量。';
    document.getElementById('artBody').dispatchEvent(new Event('input'));
    var newBtn=document.getElementById('artNew'); if(newBtn) newBtn.click();
  }catch(e){}
});
</script>`;
const dfile = path.join(out, 'admin-article-dialog.html');
fs.writeFileSync(dfile, html.replace('</body>', dlg + '\n</body>'), 'utf8');
console.log(dfile);
