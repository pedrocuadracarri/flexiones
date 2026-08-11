const SHELL = "flexiones-shell-v2";
const DEPS = "flexiones-deps-v1";
const ASSETS = [
  "./", "./index.html", "./app.js", "./styles.css", "./manifest.webmanifest",
  "./logo.png", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== DEPS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const { request } = e;
  if (request.method !== "GET") return;

  // Modelo y wasm de MediaPipe: URLs con versión, nunca cambian → cache primero.
  // Son 5 MB: cachearlos es lo que permite entrenar sin datos.
  if (new URL(request.url).origin !== self.location.origin) {
    e.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(DEPS).then(c => c.put(request, copy)); }
        return res;
      }))
    );
    return;
  }

  // Archivos propios: red primero para no servir una versión vieja de la app.
  e.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(request, copy)); }
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match("./index.html")))
  );
});
