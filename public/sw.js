let timerHandle = null;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return;
  const fresh = new Request(event.request, { cache: "no-store" });
  event.respondWith(fetch(fresh).catch(() => caches.match(event.request)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "timer-clear") {
    clearTimeout(timerHandle);
    timerHandle = null;
    event.waitUntil(self.registration.getNotifications({ tag: event.data.tag || "lisa-timer" }).then((notes) => {
      notes.forEach((note) => note.close());
    }));
    return;
  }
  if (event.data?.type !== "timer-start") return;
  clearTimeout(timerHandle);
  const endAt = Number(event.data.endAt) || 0;
  const delay = Math.max(0, endAt - Date.now());
  timerHandle = setTimeout(() => {
    self.registration.showNotification(event.data.title || "Cookbook", {
      body: "The timer is up.",
      tag: event.data.tag || "lisa-timer",
      renotify: true,
      vibrate: [220, 120, 220, 120, 320]
    });
  }, delay);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const open = clients.find((client) => client.url.includes(self.location.origin));
    if (open) return open.focus();
    return self.clients.openWindow("/");
  }));
});
