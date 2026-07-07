// СтройКонтроль — Service Worker для работы без интернета
// Версия кэша — меняй при обновлении index.html, чтобы телефон подтянул свежее
const CACHE = 'sk-cache-v6';

// Что кэшируем: само приложение + внешние библиотеки
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];

// Установка: складываем файлы в кэш
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Активация: чистим старые версии кэша
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Запросы:
// - Firestore (google api) всегда идёт в сеть — у него свой оффлайн-механизм
// - остальное: сначала сеть, при отсутствии — из кэша (network-first)
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Firestore / Firebase realtime трафик не трогаем — Firebase сам разберётся оффлайн
  if (url.includes('firestore.googleapis.com') || url.includes('firebaseio.com') || url.includes('google.com/') ) {
    return;
  }

  // Только GET кэшируем
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(resp => {
        // свежий ответ кладём в кэш
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
