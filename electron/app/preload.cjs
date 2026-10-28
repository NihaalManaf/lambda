// Sandboxed preload: the only thing the page gets is this tiny `window.lambda` API.
// Shape mirrors LambdaDesktop in src/lib/desktop.ts.

const { contextBridge, ipcRenderer } = require("electron");

// window focus comes from the native window (menus don't blur it), not the page's blur/focus events
ipcRenderer.on("lambda:focus", (_e, focused) => {
  document.documentElement?.classList.toggle("blurred", !focused);
});

const listen = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("lambda", {
  isDesktop: true,
  platform: process.platform,
  notify: (title, body) =>
    ipcRenderer.send("lambda:notify", { title: String(title ?? ""), body: body == null ? "" : String(body) }),
  setBadge: (n) => ipcRenderer.send("lambda:badge", Number(n) || 0),
  onMenu: (cb) => {
    const off = listen("lambda:menu")(cb);
    ipcRenderer.send("lambda:menu-ready"); // main flushes menu actions queued while the page loaded
    return off;
  },
});
