// 渲染层：列表 / 统计 / 语言分布 / 作者榜 / 新晋与掉队 / 详情抽屉 / 分享卡片（ES Module）
import { state } from './state.js';
import { LANG_COLORS, LANGS } from './config.js';
import { getFavs, toggleFav } from './cache.js';
import { activityScore, fetchRepoDetail, fetchReadme, fetchLatestRelease, fetchContributors } from './api.js';

// 由 app.js 注入，避免模块之间循环依赖
export const hooks = {
  onLangPick: () => {},
  onLangClear: () => {},
  onFavChanged: () => {}
};

export const $ = id => document.getElementById(id);

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function fmt(n) {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}

function signed(n) {
  return (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n));
}

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 3600) return '刚刚';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
  if (s < 86400 * 365) return Math.floor(s / 86400 / 30) + ' 个月前';
  return Math.floor(s / 86400 / 365) + ' 年前';
}

// ---------- 列表项 ----------
export function renderItem(r, rank, maxStars, trend) {
  const favs = getFavs();
  const faved = favs.has(r.name);
  const li = el('li', 'item' + (faved ? ' faved' : ''));

  const rankEl = el('div', 'rank', rank <= 3 ? '' : String(rank).padStart(2, '0'));
  if (rank <= 3) rankEl.append(el('span', 'rank-top rank-' + rank, String(rank)));
  li.append(rankEl);

  const body = el('div');
  const a = el('a', 'name', r.name);
  a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.onclick = e => { e.preventDefault(); openDrawer(r); };   // 中键 / 右键仍可新开
  body.append(a);
  if (r.desc) body.append(el('p', 'desc', r.desc));

  const meta = el('div', 'meta');
  if (r.lang) {
    const ls = el('span');
    const dot = el('i', 'lang-dot');
    dot.style.background = LANG_COLORS[r.lang] || 'var(--muted)';
    ls.append(dot, document.createTextNode(r.lang));
    meta.append(ls);
  }
  meta.append(el('span', 'stars', '★ ' + fmt(r.stars)));

  const t = trend && trend[r.name];
  if (t) {
    if (t.isNew) meta.append(el('span', 'badge new', 'NEW'));
    else if (t.dRank > 0) meta.append(el('span', 'badge up', '↑' + t.dRank));
    else if (t.dRank < 0) meta.append(el('span', 'badge down', '↓' + (-t.dRank)));
    if (t.dStars != null) {
      const g = el('span', 'gain' + (t.dStars > 0 ? ' up' : t.dStars < 0 ? ' down' : ''), '较上次 ' + signed(t.dStars) + ' ★');
      g.title = '和至少 1 小时前的一次记录相比的星标变化';
      meta.append(g);
    }
  }

  const act = activityScore(r);
  const actEl = el('span', 'act', '活跃 ' + act);
  actEl.title = '按最近提交、星标、Fork、Issue 综合计算（0-100）';
  meta.append(actEl);
  meta.append(el('span', null, 'Fork ' + fmt(r.forks)));
  meta.append(el('span', null, '更新于 ' + timeAgo(r.updated)));

  const copy = el('button', 'mini', '复制');
  copy.title = '复制项目名、描述和链接';
  copy.onclick = async () => {
    const text = r.name + ' ★' + fmt(r.stars) + '\n' + (r.desc ? r.desc + '\n' : '') + r.url;
    try { await navigator.clipboard.writeText(text); copy.textContent = '已复制'; }
    catch (e) { copy.textContent = '复制失败'; }
    setTimeout(() => { copy.textContent = '复制'; }, 1500);
  };
  meta.append(copy);

  const share = el('button', 'mini', '卡片');
  share.title = '生成分享卡片图片';
  share.onclick = () => shareCard(r, rank);
  meta.append(share);
  body.append(meta);

  if (r.topics.length) {
    const tags = el('div', 'tags');
    r.topics.forEach(tp => tags.append(el('span', 'tag', tp)));
    body.append(tags);
  }
  const bar = el('div', 'starbar');
  const fill = el('i');
  fill.style.width = (maxStars ? Math.max(2, Math.round(r.stars / maxStars * 100)) : 0) + '%';
  bar.append(fill);
  body.append(bar);
  li.append(body);

  const fav = el('button', 'fav' + (faved ? ' on' : ''), faved ? '★' : '☆');
  fav.title = '收藏 / 取消收藏';
  fav.setAttribute('aria-label', fav.title);
  fav.onclick = () => {
    const on = toggleFav(r.name);
    fav.textContent = on ? '★' : '☆';
    fav.classList.toggle('on', on);
    li.classList.toggle('faved', on);
    if (state.favOnly) hooks.onFavChanged();
  };
  li.append(fav);
  return li;
}

// ---------- 统计 / 分布 / 作者榜 ----------
export function renderStats(list) {
  const box = $('stats');
  if (!list.length) { box.hidden = true; return; }
  const totalStars = list.reduce((s, r) => s + r.stars, 0);
  const langCount = {};
  list.forEach(r => { if (r.lang) langCount[r.lang] = (langCount[r.lang] || 0) + 1; });
  const topLang = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0];
  box.hidden = false;
  const mk = (v, label) => { const d = el('div', 'stat'); d.append(el('b', null, v), el('span', null, label)); return d; };
  box.replaceChildren(
    mk(String(list.length), '当前榜单项目数'),
    mk(fmt(totalStars), '星标总数'),
    mk(fmt(Math.round(totalStars / list.length)), '平均星标'),
    mk(topLang ? topLang[0] + ' × ' + topLang[1] : '—', '最热门语言')
  );
}

export function renderDist(list) {
  const box = $('dist');
  const counts = {};
  list.forEach(r => { if (r.lang) counts[r.lang] = (counts[r.lang] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!top.length) { box.hidden = true; return; }
  const max = top[0][1];
  const rows = top.map(([lang, n]) => {
    const clickable = LANGS.includes(lang);
    const row = el('button', 'dist-row');
    row.type = 'button';
    row.disabled = !clickable;
    row.title = clickable ? '只看 ' + lang : lang;
    const track = el('span', 'dist-track');
    const fill = el('i');
    fill.style.width = Math.round(n / max * 100) + '%';
    fill.style.background = LANG_COLORS[lang] || 'var(--muted)';
    track.append(fill);
    row.append(el('span', null, lang), track, el('span', 'dist-n', String(n)));
    row.onclick = () => hooks.onLangPick(lang);
    return row;
  });
  box.hidden = false;
  if (state.lang) {
    const reset = el('button', 'mini', '清除语言筛选');
    reset.onclick = () => hooks.onLangClear();
    box.replaceChildren(el('div', 'dist-title', `当前只看 ${state.lang}，共 ${list.length} 个`), reset);
    return;
  }
  box.replaceChildren(el('div', 'dist-title', '语言分布（点击筛选）'), ...rows);
}

export function renderAuthors(list) {
  const box = $('authors');
  if (list.length < 3) { box.hidden = true; return; }
  const by = {};
  list.forEach(r => {
    const o = r.name.split('/')[0];
    by[o] = by[o] || { n: 0, stars: 0 };
    by[o].n++; by[o].stars += r.stars;
  });
  const top = Object.entries(by).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].stars - a[1].stars).slice(0, 6);
  if (!top.length) { box.hidden = true; return; }
  box.hidden = false;
  const max = top[0][1].stars || 1;
  box.replaceChildren(el('div', 'dist-title', '上榜项目最多的作者 / 组织（当前榜单）'),
    ...top.map(([name, v], i) => {
      const row = el('div', 'author-row');
      const rank = el('span', 'au-rank', String(i + 1).padStart(2, '0'));
      const img = document.createElement('img');
      img.className = 'au-avatar';
      img.alt = '';
      img.loading = 'lazy';
      img.src = 'https://github.com/' + encodeURIComponent(name) + '.png?size=56';
      img.onerror = () => img.replaceWith(el('span', 'au-avatar au-fallback', name.charAt(0).toUpperCase()));
      const info = el('div', 'au-info');
      info.append(el('b', 'au-name', name), el('span', 'au-count', v.n + ' 个项目'));
      const bar = el('div', 'au-bar');
      const fill = el('i');
      fill.style.width = (v.stars / max * 100).toFixed(1) + '%';
      bar.append(fill);
      row.append(rank, img, info, bar, el('span', 'au-stars', fmt(v.stars) + ' ★'));
      return row;
    }));
}


// ---------- 榜单对比：上次记录以来的新晋 / 掉队 ----------
export function renderChanges(repos, trend, dropped) {
  const box = $('changes');
  if (!repos.length) { box.hidden = true; return; }
  box.hidden = false;
  if (!state.hasBase) {
    box.replaceChildren(
      el('div', 'dist-title', '上次记录以来的变化'),
      el('p', 'note', '还没有可对比的记录。隔 1 小时以上再来一次，这里会列出新进前 20 和掉出榜单的项目。')
    );
    return;
  }
  const newcomers = repos.slice(0, 20)
    .map((r, i) => ({ r, rank: i + 1 }))
    .filter(x => trend[x.r.name] && trend[x.r.name].isNew);
  const col = (title, rows) => {
    const c = el('div', 'chg-col');
    c.append(el('div', 'dist-title', title));
    if (!rows.length) c.append(el('p', 'note', '无'));
    else rows.forEach(x => c.append(x));
    return c;
  };
  const rowNew = ({ r, rank }) => {
    const row = el('div', 'author-row');
    row.append(el('b', null, '#' + rank + ' ' + r.name), el('span', null, '★ ' + fmt(r.stars)));
    return row;
  };
  const rowDrop = d => {
    const row = el('div', 'author-row');
    row.append(el('b', null, '原 #' + d.rank + ' ' + d.name), el('span', null, '★ ' + fmt(d.stars)));
    return row;
  };
  const grid = el('div', 'chg-grid');
  grid.append(col('新进前 20', newcomers.map(rowNew)), col('掉出榜单', dropped.map(rowDrop)));
  box.replaceChildren(el('div', 'dist-title', '上次记录以来的变化（对比至少 1 小时前的一次记录）'), grid);
}

// ---------- 详情抽屉 ----------
let drawerTarget = '';

export async function openDrawer(r) {
  drawerTarget = r.name;
  const d = $('drawer'), bd = $('drawerBack');
  d.hidden = false; bd.hidden = false;
  requestAnimationFrame(() => { d.classList.add('open'); bd.classList.add('show'); });
  $('drawerTitle').textContent = r.name;
  $('drawerTitle').href = r.url;
  const body = $('drawerBody');
  body.replaceChildren(el('p', 'note', '加载详情…'));

  const [full, readme, rel, contribs] = await Promise.all([
    fetchRepoDetail(r.name).catch(() => null),
    fetchReadme(r.name).catch(() => null),
    fetchLatestRelease(r.name),
    fetchContributors(r.name)
  ]);
  if (drawerTarget !== r.name) return;   // 用户已经切到别的项目或关掉了

  const rows = [];
  const meta = el('div', 'meta');
  meta.append(el('span', 'stars', '★ ' + fmt(r.stars)), el('span', null, 'Fork ' + fmt(r.forks)));
  if (r.license && r.license !== 'NOASSERTION') meta.append(el('span', null, r.license));
  meta.append(el('span', null, '创建于 ' + (r.created || '').slice(0, 10)));
  meta.append(el('span', 'act', '活跃 ' + activityScore(r)));
  rows.push(meta);
  if (full) {
    rows.push(el('p', 'note', '最近提交 ' + timeAgo(full.pushed_at) + ' · Watch ' + fmt(full.subscribers_count || 0)));
  }

  rows.push(el('h4', null, '最新 Release'));
  if (rel) {
    const a = el('a', 'name', (rel.name || rel.tag_name) + '（' + rel.tag_name + '）');
    a.href = rel.html_url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.style.fontSize = '14px';
    rows.push(a, el('p', 'note', '发布于 ' + (rel.published_at || '').slice(0, 10)));
  } else {
    rows.push(el('p', 'note', '该项目还没有发布 Release。'));
  }

  rows.push(el('h4', null, '主要贡献者'));
  if (contribs.length) {
    const list = el('div', 'contribs');
    contribs.forEach(c => {
      const row = el('div', 'author-row');
      const img = document.createElement('img');
      img.className = 'avatar-sm'; img.src = c.avatar_url; img.alt = ''; img.width = 24; img.height = 24; img.loading = 'lazy';
      const who = el('div', 'contrib-who');
      const link = el('a', null, c.login);
      link.href = c.html_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      who.append(img, link);
      row.append(who, el('span', null, fmt(c.contributions) + ' 次提交'));
      list.append(row);
    });
    rows.push(list);
  } else {
    rows.push(el('p', 'note', '没有读取到贡献者信息。'));
  }

  rows.push(el('h4', null, 'README 预览'));
  if (readme) {
    rows.push(el('pre', 'readme', readme.slice(0, 4000)));
    if (readme.length > 4000) rows.push(el('p', 'note', '（仅显示前 4000 字符，完整内容请访问仓库）'));
  } else {
    rows.push(el('p', 'note', '没有读取到 README。'));
  }
  body.replaceChildren(...rows);
}

export function closeDrawer() {
  drawerTarget = '';
  const d = $('drawer'), bd = $('drawerBack');
  d.classList.remove('open'); bd.classList.remove('show');
  setTimeout(() => { if (!d.classList.contains('open')) { d.hidden = true; bd.hidden = true; } }, 200);
}

export function initDrawer() {
  $('drawerClose').onclick = closeDrawer;
  $('drawerBack').onclick = closeDrawer;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
  });
}

// ---------- Canvas 分享卡片 ----------
export function shareCard(r, rank) {
  const W = 900, H = 470;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = dark ? '#0a0e1a' : '#faf7f0', fg = dark ? '#e8ecf4' : '#1c2230';
  const muted = dark ? '#8b95a7' : '#6b7280';
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  const grad = x.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#f0b429'); grad.addColorStop(1, '#ffd977');
  x.fillStyle = grad; x.fillRect(0, 0, W, 6);
  x.font = '600 20px Consolas, monospace';
  x.fillStyle = '#f0b429'; x.fillText('★ GitHub 排行榜 · 第 ' + rank + ' 名', 40, 60);
  x.fillStyle = fg; x.font = 'bold 44px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  x.fillText(r.name.length > 32 ? r.name.slice(0, 32) + '…' : r.name, 40, 125);
  x.fillStyle = muted; x.font = '22px "Segoe UI", "PingFang SC", sans-serif';
  const desc = r.desc || '';
  x.fillText(desc.length > 52 ? desc.slice(0, 52) + '…' : desc, 40, 170);
  x.font = 'bold 34px Consolas, monospace';
  x.fillStyle = '#f0b429'; x.fillText('★ ' + fmt(r.stars), 40, 260);
  x.fillStyle = fg; x.fillText('Fork ' + fmt(r.forks), 260, 260);
  x.fillText('活跃 ' + activityScore(r), 500, 260);
  x.fillStyle = muted; x.font = '20px "Segoe UI", sans-serif';
  if (r.lang) x.fillText('语言 ' + r.lang, 40, 305);
  x.fillText('更新于 ' + timeAgo(r.updated), 260, 305);
  x.fillStyle = '#f0b429'; x.font = '600 22px Consolas, monospace';
  x.fillText(r.url.replace('https://', ''), 40, 400);
  x.fillStyle = grad; x.fillRect(0, H - 6, W, 6);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = r.name.replace('/', '_') + '-card.png';
  a.click();
}
