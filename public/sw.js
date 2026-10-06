// Service worker mínimo: permite instalar la app; siempre pide datos frescos a la red.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
