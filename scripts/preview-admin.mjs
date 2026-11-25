// 生成后台各面板的预览页（用 dev 密码真登录一次），用于本机截图核对 UI
// 用法：先 node scripts/dev-server.mjs，再 node scripts/preview-admin.mjs → 写到 %TEMP%\ghrank-preview\*.html
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = path.join(os.tmpdir(), 'ghrank-preview');
fs.mkdirSync(out, { recursive: true });

const res = await fetch('http://127.0.0.1:8123/admin');
if (!res.ok) throw new Error('取 /admin 失败：' + res.status);
const html = await res.text();

// dev-server 的管理密码写死是 dev
const LOGIN = `
  var pwInput = document.getElementById('pw');
  if (pwInput) pwInput.value = 'dev';
  var form = document.getElementById('loginForm');
  if (form) form.requestSubmit();`;

function page(name, afterLogin) {
  const inject = `<script>
window.addEventListener('load', function(){
  try{ ${LOGIN} }catch(e){}
  setTimeout(function(){ try{ ${afterLogin} }catch(e){} }, 1400);
});
</script>`;
  const file = path.join(out, name + '.html');
  fs.writeFileSync(file, html.replace('</body>', inject + '\n</body>'), 'utf8');
  console.log(file);
}

for (const p of ['overview', 'layout', 'articles', 'nav', 'seo', 'submit', 'translate', 'ad', 'links']) {
  page('admin-' + p, `var b=document.querySelector('.nav[data-tab="${p}"]'); if(b) b.click();`);
}

// 写文章弹窗放大后的样子（带上示例正文，看左右两栏排版）
page(
  'admin-article-dialog',
  `var nb=document.querySelector('.nav[data-tab="articles"]'); if(nb) nb.click();
   document.getElementById('artTitleIn').value='示例：用 Cloudflare Workers 做一个只读排行榜';
   document.getElementById('artDate').value='2026-11-25';
   document.getElementById('artSummary').value='演示写文章弹窗放大后的排版：左边写、右边实时预览。';
   document.getElementById('artBody').value='## 为什么要静态化\\n\\nGitHub API 有速率限制，访客一多就 403。把榜单数据定时写进仓库，前端直接读静态文件，成本几乎为零。\\n\\n| 环节 | 做法 | 效果 |\\n| --- | --- | --- |\\n| 数据 | Action 每 3 小时抓一次 | 不占访客额度 |\\n| 边缘 | Worker 缓存成品响应 | 命中 100ms 级 |\\n| 前端 | 按需加载单个时间范围 | 首屏更小 |\\n\\n> 这套组合拳在免费额度内就能撑住日常流量。';
   document.getElementById('artBody').dispatchEvent(new Event('input'));
   var nb2=document.getElementById('artNew'); if(nb2) nb2.click();`
);
