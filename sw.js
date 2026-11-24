const files = [
  "./",
  "./index.html",
  "./icon-wallet-b.png?v=20261120b",
  "./ledger.html",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icon-wallet-b.png",
  "./assets/header-current.svg",
  "./assets/takuwae-tabs-3d-hq.webp?v=34",
  "./supabase/config.js",
  "./supabase/start-ledger.js",
  "./supabase/ledger-gestures.js",
  "./supabase/first-import.js",
  "./supabase/sync-api.js",
  "./supabase/sync-app-bridge.js",
  "./supabase/sync-app-frame.js",
  "./supabase/sync-app.js",
  "./supabase/sync-auth-session.js",
  "./supabase/sync-engine.js",
  "./supabase/sync-merge.js",
  "./supabase/sync-model.js",
  "./supabase/sync-remote-trial.js",
  "./supabase/sync-session.js"
];
const cacheKey = 'takuwae-v2.3.3-money-wave-fix-20261124';
const cachedUrls = new Set(files.map(file=>new URL(file,self.registration.scope).href));
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(cacheKey);
    await cache.addAll(files.map(file=>new Request(new URL(file,self.registration.scope),{cache:'reload'})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{
  if(event.data!=='offline-ready'||!event.ports[0])return;
  event.waitUntil((async()=>{
    const cache=await caches.open(cacheKey);
    const entries=await Promise.all(files.map(file=>cache.match(new URL(file,self.registration.scope))));
    event.ports[0].postMessage(entries.every(Boolean));
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||!cachedUrls.has(request.url))return;
  event.respondWith(fetch(request).catch(async error=>{
    const cache=await caches.open(cacheKey);
    const cached=await cache.match(request);
    if(!cached)throw error;
    return cached;
  }));
});
