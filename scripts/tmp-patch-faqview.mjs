import fs from 'node:fs';

const F = 'index.html';
const raw = fs.readFileSync(F, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

function apply(label, find, repl, expect = 1) {
  const n = s.split(find).length - 1;
  if (n !== expect) throw new Error(`[${label}] 命中 ${n} 次，期望 ${expect}`);
  s = s.split(find).join(repl);
  console.log(`ok ${label}`);
}

// 1) 顶栏「问答」由跳转链接改成同页 tab
apply('nav-faq-tab',
  `<a class="mnav" href="/faq">问答</a>`,
  `<button class="mnav" id="tabFaq" data-view="faq" type="button" aria-selected="false">问答</button>`);

// 2) head 里加直达标记
apply('head-want-faq',
  `// 文章视图的直达标记：/ ?page=articles、#artView
window.__wantArt = (function () {
  try {
    if (location.hash === '#artView') return true;
    if (new URLSearchParams(location.search).get('page') === 'articles') return true;
  } catch (e) {}
  return false;
})();`,
  `// 文章视图的直达标记：/ ?page=articles、#artView
window.__wantArt = (function () {
  try {
    if (location.hash === '#artView') return true;
    if (new URLSearchParams(location.search).get('page') === 'articles') return true;
  } catch (e) {}
  return false;
})();
// 问答视图的直达标记：/ ?page=faq、#faqView
window.__wantFaq = (function () {
  try {
    if (location.hash === '#faqView') return true;
    if (new URLSearchParams(location.search).get('page') === 'faq') return true;
  } catch (e) {}
  return false;
})();`);

// 3) 文章视图后面加问答视图
apply('faq-markup',
  `<div id="artViewList"><div class="empty">正在加载文章…</div></div>
  </section>`,
  `<div id="artViewList"><div class="empty">正在加载文章…</div></div>
  </section>
  <section class="artview faqview" id="faqView" hidden aria-label="问答">
    <div class="artvhead">
      <h2>问答</h2>
      <p class="artvlead">数据怎么算、多久更新、能不能被搜索引擎和 AI 收录、加密文章怎么解锁——常见问题都在这儿。</p>
    </div>
    <div class="artvbar">
      <input type="search" id="faqSearch" placeholder="搜索问题或答案…" aria-label="搜索问答" autocomplete="off">
    </div>
    <div class="chips" id="faqChips" aria-label="按标签筛选问答"></div>
    <div id="faqList"><div class="empty">正在加载问答…</div></div>
  </section>`);

// 4) CSS
apply('faq-css',
  `@media (max-width:600px){.artvbar{flex-wrap:wrap}.artvbar input,.artvbar select{flex:1 1 100%}}`,
  `@media (max-width:600px){.artvbar{flex-wrap:wrap}.artvbar input,.artvbar select{flex:1 1 100%}}
  body[data-page="faq"] #rankBar,body[data-page="faq"] #stats,body[data-page="faq"] #adHomeTop{display:none}
  .faqview .qa{border:1px solid var(--line);border-radius:12px;background:var(--card);margin:0 0 10px;overflow:hidden}
  .faqview .qa>summary{cursor:pointer;list-style:none;display:flex;gap:10px;align-items:flex-start;padding:14px 16px;font-weight:600;font-size:14.5px;line-height:1.55}
  .faqview .qa>summary::-webkit-details-marker{display:none}
  .faqview .qa>summary:hover{background:var(--accent-soft)}
  .faqview .qa>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .faqview .qa .qmark{flex:0 0 auto;width:20px;height:20px;margin-top:2px;border-radius:6px;background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:800;display:grid;place-items:center}
  .faqview .qa .qtext{flex:1 1 auto;min-width:0}
  .faqview .qa .qtag{flex:0 0 auto;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 7px;margin-top:3px}
  .faqview .qa .ans{padding:0 16px 15px 46px;color:#39404b;font-size:14px;line-height:1.85}
  .faqview .qa .ans p{margin:0 0 8px}
  .faqview .qa .ans p:last-child{margin-bottom:0}
  .faqview .qa .ans code{background:var(--chip);border-radius:5px;padding:1px 5px;font-size:12.5px}
  .faqview .qa .ans a{color:var(--accent)}
  @media (max-width:600px){.faqview .qa>summary{padding:13px 14px;font-size:14px}.faqview .qa .ans{padding:0 14px 14px 44px;font-size:13.5px}}`);

// 5) JS：问答视图逻辑，插在 renderArticles 之前
apply('faq-js',
  `    function renderArticles(list){`,
  `    // ---- 问答视图（/?page=faq）：和导航、文章共用一套页内切换，不再整页跳 ----
    var faqq={loaded:false,loading:null,items:[],q:'',tag:'all'};
    function faqTagsOf(it){
      if(Array.isArray(it.tags)) return it.tags.map(str).filter(Boolean);
      var t=str(it.tag); return t?[t]:[];
    }
    function faqPlain(v){ return str(v).replace(/\`/g,'').replace(/\\*\\*/g,''); }
    function faqAnswerHtml(v){
      var raw=str(v);
      if(window.KeeMd&&typeof window.KeeMd.render==='function'){
        try{ return window.KeeMd.render(raw); }catch(e){}
      }
      return artvEsc(raw).replace(/\\n/g,'<br>');
    }
    function faqMatch(it){
      if(faqq.tag!=='all'&&faqTagsOf(it).indexOf(faqq.tag)<0) return false;
      var q=faqq.q; if(!q) return true;
      var hay=(faqPlain(it.q)+' '+faqPlain(it.a)+' '+faqTagsOf(it).join(' ')).toLowerCase();
      return hay.indexOf(q)>=0;
    }
    function faqChips(){
      var box=document.getElementById('faqChips');
      if(!box) return;
      var seen={},tags=[];
      faqq.items.forEach(function(it){ faqTagsOf(it).forEach(function(t){ if(!seen[t]){ seen[t]=1; tags.push(t); } }); });
      var html='<button type="button" class="chip'+(faqq.tag==='all'?' is-on':'')+'" data-faqtag="all">全部</button>';
      tags.forEach(function(t){
        html+='<button type="button" class="chip'+(faqq.tag===t?' is-on':'')+'" data-faqtag="'+artvEsc(t)+'">'+artvEsc(t)+'</button>';
      });
      box.innerHTML=html;
    }
    function renderFaq(){
      var box=document.getElementById('faqList');
      if(!box) return;
      var items=faqq.items.filter(faqMatch);
      if(!items.length){
        box.innerHTML='<div class="empty">没有匹配的问题'+(faqq.q?'，换个关键词试试':'')+'。</div>';
        return;
      }
      var html='';
      items.forEach(function(it,idx){
        var tags=faqTagsOf(it);
        html+='<details class="qa"'+(idx===0&&!faqq.q?' open':'')+'>'+
          '<summary><span class="qmark">Q</span><span class="qtext">'+artvEsc(faqPlain(it.q))+'</span>'+
          (tags.length?'<span class="qtag">'+artvEsc(tags[0])+'</span>':'')+'</summary>'+
          '<div class="ans">'+faqAnswerHtml(it.a)+'</div></details>';
      });
      box.innerHTML=html;
    }
    function loadFaq(){
      if(faqq.loaded){ renderFaq(); return; }
      if(faqq.loading) return;
      var box=document.getElementById('faqList');
      faqq.loading=getJSON('/data/qa.json').then(function(data){
        var arr=Array.isArray(data)?data:(data&&Array.isArray(data.items)?data.items:[]);
        faqq.items=arr.filter(function(it){ return it&&str(it.q); });
        faqq.loaded=true;
        faqChips();
        renderFaq();
      }).catch(function(){
        if(box) box.innerHTML='<div class="empty">问答没读出来，稍后再试。</div>';
      });
    }

    function renderArticles(list){`);

// 6) setView 支持 faq
apply('setview',
  `    function setView(v){
      var v2 = (v==='nav'||v==='articles') ? v : 'rank';
      var rank=document.getElementById('rank'), nv=document.getElementById('navView'), av=document.getElementById('artView');
      if(rank) rank.hidden = v2!=='rank';
      if(nv) nv.hidden = v2!=='nav';
      if(av) av.hidden = v2!=='articles';
      document.body.setAttribute('data-page', v2);
      var tabs={rank:document.getElementById('tabRank'),nav:document.getElementById('tabNav'),articles:document.getElementById('tabArticles')};`,
  `    function setView(v){
      var v2 = (v==='nav'||v==='articles'||v==='faq') ? v : 'rank';
      var rank=document.getElementById('rank'), nv=document.getElementById('navView'), av=document.getElementById('artView'), fv=document.getElementById('faqView');
      if(rank) rank.hidden = v2!=='rank';
      if(nv) nv.hidden = v2!=='nav';
      if(av) av.hidden = v2!=='articles';
      if(fv) fv.hidden = v2!=='faq';
      document.body.setAttribute('data-page', v2);
      var tabs={rank:document.getElementById('tabRank'),nav:document.getElementById('tabNav'),articles:document.getElementById('tabArticles'),faq:document.getElementById('tabFaq')};`);

apply('setview-url',
  `      try{ if(history.replaceState) history.replaceState(null,'', v2==='nav'?'/?page=nav':(v2==='articles'?'/?page=articles':'/')); }catch(e){}
      if(v2==='nav') loadNav();
      if(v2==='articles') loadArtView();`,
  `      try{ if(history.replaceState) history.replaceState(null,'', v2==='nav'?'/?page=nav':(v2==='articles'?'/?page=articles':(v2==='faq'?'/?page=faq':'/'))); }catch(e){}
      if(v2==='nav') loadNav();
      if(v2==='articles') loadArtView();
      if(v2==='faq') loadFaq();`);

// 7) 事件绑定 + 直达判断
apply('wire',
  `    if(tArt) tArt.addEventListener('click',function(){ setView('articles'); });`,
  `    if(tArt) tArt.addEventListener('click',function(){ setView('articles'); });
    var tFaq=document.getElementById('tabFaq');
    if(tFaq) tFaq.addEventListener('click',function(){ setView('faq'); });
    var faqSearchBox=document.getElementById('faqSearch');
    if(faqSearchBox) faqSearchBox.addEventListener('input',function(){ faqq.q=str(this.value).toLowerCase(); renderFaq(); });
    var faqChipsBox=document.getElementById('faqChips');
    if(faqChipsBox) faqChipsBox.addEventListener('click',function(e){
      var b=e.target&&e.target.closest?e.target.closest('[data-faqtag]'):null;
      if(!b) return;
      faqq.tag=b.getAttribute('data-faqtag')||'all';
      faqChips();
      renderFaq();
    });`);

apply('want',
  `    var wantArt = window.__wantArt === true || /[?&]page=articles(?:&|$)/.test(location.search) || location.hash === '#artView';
    if(wantArt) setView('articles');
    else if(wantNav) setView('nav');`,
  `    var wantArt = window.__wantArt === true || /[?&]page=articles(?:&|$)/.test(location.search) || location.hash === '#artView';
    var wantFaq = window.__wantFaq === true || /[?&]page=faq(?:&|$)/.test(location.search) || location.hash === '#faqView';
    if(wantFaq) setView('faq');
    else if(wantArt) setView('articles');
    else if(wantNav) setView('nav');`);

if (crlf) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(F, s, 'utf8');
console.log('written', F);
