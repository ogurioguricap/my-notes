/* Service Worker —— 只做「断网兜底」，绝不拖慢或卡住页面
 *
 * 策略要点（踩坑之后的决定）：
 * 1. 页面 / JS / CSS / 数据一律「网络优先」：能联网就拿最新版本，缓存只在离线时兜底，
 *    避免「旧 JS 配新 HTML」导致整页不执行、永远停在加载中。
 * 2. 缓存版本号变更时清空所有旧缓存。
 * 3. 从缓存兜底返回时通知页面，便于提示「当前是离线缓存版本」。
 */
const CACHE = 'notes-v6';
const CORE = ['./', './index.html', './css/style.css', './js/app.js', './js/search.js', './js/highlight.js', './js/graph.js', './manifest.webmanifest'];

// 这些请求任何时候都以网络为准
const ALWAYS_FRESH = [/\/data\//, /\/ink\//, /\.js$/, /\.css$/, /\/index\.html$/, /\/$/];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CORE))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 跨域（KaTeX CDN 等）交给浏览器

  const wantsFresh = ALWAYS_FRESH.some((re) => re.test(url.pathname)) || req.mode === 'navigate';

  if (wantsFresh) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true }).then((hit) => {
            if (!hit) return caches.match('./index.html');
            self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage({ type: 'offline-cache', url: url.pathname })));
            return hit;
          })
        )
    );
    return;
  }

  // 其余静态资源（图片、附件）：缓存优先，省流量
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
    )
  );
});

// 页面可主动要求清空缓存（配合「清理缓存并重新打开」按钮）
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'clear-cache') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});
