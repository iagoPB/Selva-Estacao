// service worker: recebe as notificações da estação (mesmo com o app fechado)
// e guarda a casca da interface pra abrir rápido
const CACHE = "selva-v4";
const CASCA = ["./", "index.html", "estilo.css", "app.js", "manifest.webmanifest",
  "icones/icone-192.png", "icones/selo-96.png",
  "fontes/inter.woff2", "fontes/zilla-slab-400.woff2", "fontes/zilla-slab-700.woff2", "fontes/zilla-slab-400-italic.woff2"];

self.addEventListener("install", evento => {
  evento.waitUntil(caches.open(CACHE).then(c => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", evento => {
  evento.waitUntil(
    caches.keys()
      .then(nomes => Promise.all(nomes.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// interface vai rede primeiro e cache se estiver sem rede. api, fotos e ws passam direto
self.addEventListener("fetch", evento => {
  const url = new URL(evento.request.url);
  if (evento.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/fotos/")) return;
  evento.respondWith(
    fetch(evento.request)
      .then(resposta => {
        // erro (ex.: 502 enquanto a estação reinicia) não vai
        // pro cache, usa a versão boa que já tinha
        if (!resposta.ok) return caches.match(evento.request).then(r => r || resposta);
        const copia = resposta.clone();
        caches.open(CACHE).then(c => c.put(evento.request, copia));
        return resposta;
      })
      .catch(() => caches.match(evento.request).then(r => r || caches.match("index.html")))
  );
});

self.addEventListener("push", evento => {
  let dados = {};
  try {
    dados = evento.data ? evento.data.json() : {};
  } catch {
    dados = { corpo: evento.data ? evento.data.text() : "" };
  }
  const opcoes = {
    body: dados.corpo || "",
    icon: "icones/icone-192.png",
    badge: "icones/selo-96.png",
    tag: dados.tag || "selva",
    renotify: true,
    vibrate: [120, 60, 120],
    data: { url: dados.url || "./" }
  };
  if (dados.imagem) opcoes.image = dados.imagem;
  evento.waitUntil(self.registration.showNotification(dados.titulo || "selva!", opcoes));
});

// tocar na notificação abre o app (ou traz pra frente se já estiver aberto)
self.addEventListener("notificationclick", evento => {
  evento.notification.close();
  const alvo = new URL(evento.notification.data.url || "./", self.registration.scope).href;
  evento.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(janelas => {
      for (const j of janelas) {
        if (j.url.startsWith(self.registration.scope) && "focus" in j) return j.focus();
      }
      return self.clients.openWindow(alvo);
    })
  );
});
