/* Service Worker：缓存页面外壳（HTML/JS/图标），让离线也能打开；GitHub API 不缓存，由页面自己的 localStorage 管理 */
const CACHE = 'ghrank-shell-v20';
const SHELL = ['./', 'index.html', 'js/bundle.js', 'manifest.json', 'icon.svg'];
const DATA = 'data/repos.js';   // 静态数据可能暂时不存在，单独缓存、失败不影响安装

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    c.addAll(SHELL).then(() =>
      fetch(DATA).then(res => (res.ok ? c.put(DATA, res) : null)).catch(() => null)
    )
  ));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域（GitHub API 等）直接走网络
  // 接口和后台页面不经过缓存，直接走网络，避免保活页等接口时卡住
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/') || url.pathname === '/keepalive' || url.pathname === '/admin') return;
  // 网络优先，失败时回退到缓存的外壳，保证线上更新后能拿到新代码
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
