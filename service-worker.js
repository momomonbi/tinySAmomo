// tinySA PWA Service Worker
// Stale-while-revalidate: 即キャッシュから返し、バックグラウンドで更新。
// オフラインでも動作可能 (実機接続は別途必要)。

const CACHE_NAME = 'tinySA-v9';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './tinysa.js',
  './spectrum.js',
  './waterfall.js',
  './tvchannels.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // HTTP キャッシュをバイパスして必ず最新を取得 (古い古いファイルがプリキャッシュされる問題回避)
      Promise.all(ASSETS.map(url =>
        fetch(url, { cache: 'reload' })
          .then(resp => resp.ok ? cache.put(url, resp) : null)
          .catch(() => null)
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // GET 以外、外部ドメインはスルー
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const fetchPromise = fetch(req).then((networkResp) => {
        if (networkResp && networkResp.ok) {
          cache.put(req, networkResp.clone()).catch(() => {});
        }
        return networkResp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
