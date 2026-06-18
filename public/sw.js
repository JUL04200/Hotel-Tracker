self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Hotel Tracker', {
      body: data.body || 'Une chambre est disponible !',
      icon: data.icon || '/icon.png',
      badge: '/icon.png',
      data: { url: data.url },
      vibrate: [200, 100, 200],
      requireInteraction: true,
      actions: [{ action: 'open', title: 'Voir la chambre' }]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (url) {
    event.waitUntil(clients.openWindow(url));
  }
});
