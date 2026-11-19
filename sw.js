// Service worker: يستقبل الإشعارات حتى لو الصفحة مسكّرة
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'حجز الخيام', {
    body: d.body || '', tag: d.tag || undefined, renotify: true,
    icon: 'icon-192.png', badge: 'icon-192.png', dir: 'rtl', lang: 'ar',
    requireInteraction: !!d.urgent,
    vibrate: d.urgent ? [300, 150, 300, 150, 300] : [200, 100, 200],
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) { c.postMessage({ open: url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
