// ============================================================
// Las Noches – Service Worker  (PWA + background notifications)
// ============================================================

const CACHE_NAME = 'lasnoches-v3';

// Use relative paths so the SW works on any host/subfolder
const BASE = self.registration.scope;
const SHELL_FILES = [
  BASE + 'index.html',
  BASE + 'admin.html',
  BASE + 'styles.css',
  BASE + 'app.js',
  BASE + 'receptionist.js',
  BASE + 'admin.js',
  BASE + 'manifest.json',
  BASE + 'manifest-admin.json',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(SHELL_FILES).catch(err =>
        console.warn('SW: Some files failed to cache', err)
      )
    )
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always network-first for Supabase
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ error: 'Offline – check your connection.' }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── Message: show notification from page ─────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon:             '/icons/icon-192.png',
        badge:            '/icons/icon-192.png',
        tag,
        requireInteraction: true,
        vibrate:          [200, 100, 200],
        actions: [
          { action: 'dismiss', title: 'Dismiss' },
        ],
      })
    );
  }
});

// ── Notification click ────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  // Focus or open the receptionist page
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('index.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(BASE + 'index.html');
    })
  );
});