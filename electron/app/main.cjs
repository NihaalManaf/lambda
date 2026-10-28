// lambda — macOS shell. Boots the Next server on a free loopback port, then shows it in a
// native-feeling window (inset traffic lights, real menus, notifications, dock badge).
//
//   packaged: Resources/server/server.js (Next standalone) run with electron's own node
//   dev:      `next dev` from the repo (npm run app:dev)
//
// Data: every mode shares ~/Library/Application Support/lambda/data (see src/lib/store.ts).

const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell, screen, session } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DEV = !app.isPackaged;
const REPO = path.resolve(__dirname, "..", ".."); // dev only
const PAPER = "#f8f8f6";
const HEADER_H = 56; // keep in sync with the header (h-14) in src/app/layout.tsx
const LIGHTS = { x: 20, y: Math.round(HEADER_H / 2 - 7) };

app.setName("lambda");
// the page sees "lambda-desktop" in its UA → html.desktop before first paint
app.userAgentFallback = `${app.userAgentFallback} lambda-desktop/${app.getVersion()}`;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let server = null; // child process
let origin = null; // http://127.0.0.1:<port>
let ready = false; // server answered our nonce
let quitting = false;
let log = null; // server.log write stream

const userData = () => app.getPath("userData");
const dataDir = () => path.join(userData(), "data");
const logFile = () => path.join(userData(), "logs", "server.log");

function openLog() {
  if (log) return log;
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  log = fs.createWriteStream(logFile(), { flags: "a" });
  return log;
}
const note = (line) => openLog().write(`--- ${line}\n`);

// ---------- environment ----------

// Finder-launched apps get PATH=/usr/bin:/bin:/usr/sbin:/sbin. Ask the login shell for the real one
// so `claude`, `npx`, `node`, `gh` resolve for the server and everything it spawns.
// Hard 5s cap: resolve as soon as the marker prints, and kill the shell's whole group on timeout, so
// a .zshrc that starts a daemon holding stdout (or waits on a prompt) can't hang the launch.
const MARK = "__LAMBDA_PATH__";
function loginShellPath() {
  return new Promise((resolve) => {
    const sh = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    let out = "";
    let done = false;
    let child;
    const finish = (value, kill = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child?.stdout?.destroy();
      if (kill)
        try {
          process.kill(-child.pid, "SIGKILL"); // stuck: the shell and anything it started for us
        } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish("", true), 5000);
    try {
      child = spawn(sh, ["-ilc", `printf "${MARK}%s${MARK}" "$PATH"`], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true, // own group, so a timeout can take down whatever .zshrc started

        env: { ...process.env, DISABLE_AUTO_UPDATE: "true", ZSH_DISABLE_COMPFIX: "true", TERM: "dumb" },
      });
    } catch {
      return finish("");
    }
    child.on("error", () => finish(""));
    child.stdout.on("data", (b) => {
      out += b;
      const m = out.match(new RegExp(`${MARK}(.*?)${MARK}`, "s"));
      if (m) finish(m[1]);
    });
    child.on("exit", () => setTimeout(() => finish(""), 50));
  });
}

async function resolvePath() {
  const home = os.homedir();
  const parts = [
    await loginShellPath(),
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.npm-global/bin`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(parts.filter(Boolean).flatMap((p) => p.split(":")).filter(Boolean))].join(":");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => (port === 3000 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}

// secrets (settings, cached logins) stay private whatever the source modes were
function lockDown(dir) {
  fs.chmodSync(dir, 0o700);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) lockDown(p);
    else if (ent.isFile()) fs.chmodSync(p, 0o600);
  }
}

// First launch on a machine: seed Application Support from the repo's data (demo + settings).
// Copied to a temp dir and renamed into place, so a half-finished copy is never mistaken for a store.
function migrateData() {
  const dest = dataDir();
  if (fs.existsSync(dest)) return;
  const seed = process.env.LAMBDA_SEED_DIR || path.join(os.homedir(), "Documents/personal_tools/lambda/data");
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    if (fs.existsSync(seed)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(seed, tmp, { recursive: true, preserveTimestamps: true });
      lockDown(tmp);
      fs.renameSync(tmp, dest);
      note(`seeded data from ${seed}`);
    }
  } catch (e) {
    note(`data migration failed: ${e?.stack || e}`);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  fs.chmodSync(dest, 0o700);
}

// ---------- server ----------

// Ready = *our* server answers /api/health with the nonce we gave it (not whoever grabbed the port).
function waitForServer(child, nonce, timeoutMs) {
  const until = Date.now() + timeoutMs;
  const dead = () => child.exitCode !== null || child.signalCode !== null;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${origin}/api/health`, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let ok = false;
          try {
            ok = res.statusCode === 200 && JSON.parse(body).nonce === nonce;
          } catch {}
          if (ok && !dead()) resolve();
          else retry();
        });
      });
      req.setTimeout(15000, () => req.destroy());
      req.on("error", retry);
    };
    const retry = () => {
      if (quitting) return reject(new Error("quitting"));
      if (dead()) return reject(new Error(`server exited (${child.exitCode ?? child.signalCode})`));
      if (Date.now() > until) return reject(new Error("server did not start in time"));
      setTimeout(attempt, 120);
    };
    attempt();
  });
}

async function startServer() {
  ready = false;
  const [port, PATH] = await Promise.all([freePort(), resolvePath()]);
  migrateData();
  openLog();
  note(`${new Date().toISOString()} starting on 127.0.0.1:${port}`);
  // diagnostics: the agents need these on PATH (claude for verify runs, npx for playwright mcp)
  for (const bin of ["claude", "npx", "node"]) {
    const found = PATH.split(":").map((d) => path.join(d, bin)).find((p) => fs.existsSync(p));
    note(`${bin}: ${found ?? "NOT FOUND on PATH"}`);
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const env = {
    ...process.env,
    PATH,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    ELECTRON_RUN_AS_NODE: "1", // electron's binary behaves as plain node
    NEXT_TELEMETRY_DISABLED: "1",
    LAMBDA_DATA_DIR: dataDir(),
    LAMBDA_NONCE: nonce,
  };
  let cmd;
  if (DEV) {
    cmd = [path.join(REPO, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)];
    env.NODE_ENV = "development";
  } else {
    // boot.cjs = parent watchdog, then require(server.js)
    cmd = [path.join(process.resourcesPath, "server", "lambda-boot.cjs")];
    env.LAMBDA_SERVER_ENTRY = path.join(process.resourcesPath, "server", "server.js");
    env.NODE_ENV = "production";
  }

  // own process group so quitting (or the watchdog) also stops whatever the server spawned
  const child = spawn(process.execPath, cmd, {
    cwd: DEV ? REPO : path.join(process.resourcesPath, "server"),
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = child;
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  if (DEV) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  child.on("exit", (code, signal) => {
    note(`server exited (${code ?? signal})`);
    // only a server that was up counts here; a startup failure is reported by boot()
    if (server === child && ready && !quitting) serverDown(`the local server stopped (${code ?? signal}).`);
  });

  origin = `http://127.0.0.1:${port}`;
  await waitForServer(child, nonce, DEV ? 180_000 : 60_000);
  ready = true;
}

function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const pid = server.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      server.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }, 1500).unref();
}

async function boot() {
  try {
    await startServer();
    if (win && !win.isDestroyed()) await enter(win);
  } catch (e) {
    if (!quitting) serverDown(`lambda couldn't start its local server — ${e.message}`);
  }
}

let downDialog = false;
async function serverDown(msg) {
  ready = false;
  stopServer();
  stopRunWatch();
  if (!win || win.isDestroyed()) createWindow({ error: msg });
  else win.loadURL(splash(msg));
  if (downDialog) return;
  downDialog = true;
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: "lambda's local server stopped",
    detail: `${msg}\n\nlog: ${logFile()}`,
    buttons: ["Restart", "Open Log", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  downDialog = false;
  if (response === 0) {
    if (win && !win.isDestroyed()) win.loadURL(splash());
    boot().then(() => ready && startRunWatch());
  } else if (response === 1) shell.openPath(logFile());
  else app.quit();
}

// ---------- window ----------

const stateFile = () => path.join(userData(), "window-state.json");

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      s.x + 80 < a.x + a.width && s.x + s.width - 80 > a.x && s.y >= a.y - 10 && s.y + 40 < a.y + a.height,
    );
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return { width: 1320, height: 860 };
  }
}

function trackState(w) {
  let t = null;
  const save = () => {
    if (w.isDestroyed()) return;
    const maximized = w.isMaximized();
    const b = maximized ? w.getNormalBounds() : w.getBounds();
    try {
      fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized }));
    } catch {}
  };
  const later = () => {
    clearTimeout(t);
    t = setTimeout(save, 400);
  };
  w.on("resize", later);
  w.on("move", later);
  w.on("close", save);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// paper + λ while the server boots; with `error`, the same page explains what went wrong
function splash(error) {
  const err = error ? `${error}\nlog: ${logFile()}` : "";
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${PAPER};color:#181818;-webkit-user-select:none;cursor:default;-webkit-app-region:drag}
body{display:grid;place-items:center;font-family:"New York","Iowan Old Style","Times New Roman",serif;transition:opacity .16s ease-out}
.l{font-size:92px;line-height:1;animation:in .35s cubic-bezier(.22,1,.36,1) both}
.l span{text-shadow:0 0 40px #e7a3ff}
.e{font:13px/1.5 -apple-system,system-ui;color:#727272;max-width:440px;text-align:center;margin-top:18px;white-space:pre-wrap;-webkit-user-select:text;-webkit-app-region:no-drag}
@keyframes in{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}
</style></head><body><div><div class="l"><span>λ</span></div><div class="e">${esc(err)}</div></div></body></html>`)}`;
}

// splash → app as one motion: fade the λ out, load the page with #boot (layout skips the hero's
// entrance stagger and fades the whole page in once), then forget the splash so Back can't reach it
async function enter(w) {
  const wc = w.webContents;
  if (wc.getURL().startsWith("data:")) {
    await wc.executeJavaScript("document.body.style.opacity='0'").catch(() => {});
    await new Promise((r) => setTimeout(r, 160));
  }
  if (w.isDestroyed()) return;
  pendingFirst.set(wc.id, true);
  await w.loadURL(`${origin}/#boot`).catch(() => {});
}
const pendingFirst = new Map(); // webContents id → clear history after the first app load

const isLocal = (url) => {
  try {
    return !!origin && new URL(url).origin === origin;
  } catch {
    return false;
  }
};

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") shell.openExternal(url);
  } catch {}
}

// ---------- menu → page ----------

// Menu actions wait until the page has subscribed (window just reopened, page still loading).
let menuReady = false;
let menuQueue = [];

function send(action) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (menuReady) win.webContents.send("lambda:menu", action);
  else menuQueue = [...menuQueue.filter((a) => a.type !== action.type), action];
}
const go = (p) => () => send({ type: "navigate", path: p });

function flushMenu() {
  menuReady = true;
  const q = menuQueue;
  menuQueue = [];
  for (const a of q) win?.webContents.send("lambda:menu", a);
}

function contextMenu(wc, p) {
  const items = [];
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!p.dictionarySuggestions.length) items.push({ label: "No Guesses Found", enabled: false });
    items.push({ label: "Learn Spelling", click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    items.push({ type: "separator" });
  }
  const sel = p.selectionText.trim();
  if (sel && process.platform === "darwin") {
    const short = sel.length > 24 ? `${sel.slice(0, 24)}…` : sel;
    items.push({ label: `Look Up “${short}”`, click: () => wc.showDefinitionForSelection() });
    items.push({ type: "separator" });
  }
  if (p.linkURL && !isLocal(p.linkURL)) {
    items.push({ label: "Open Link in Browser", click: () => openExternal(p.linkURL) });
    items.push({ label: "Copy Link", click: () => require("electron").clipboard.writeText(p.linkURL) });
    items.push({ type: "separator" });
  }
  if (p.isEditable) {
    items.push(
      { role: "cut", enabled: p.editFlags.canCut },
      { role: "copy", enabled: p.editFlags.canCopy },
      { role: "paste", enabled: p.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll" },
    );
  } else if (sel) items.push({ role: "copy" });
  if (DEV) items.push({ type: "separator" }, { label: "Inspect Element", click: () => wc.inspectElement(p.x, p.y) });
  while (items.length && items[items.length - 1].type === "separator") items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win ?? undefined });
}

function createWindow({ error } = {}) {
  const s = loadState();
  win = new BrowserWindow({
    x: s.x,
    y: s.y,
    width: s.width || 1320,
    height: s.height || 860,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    title: "lambda",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: LIGHTS,
    vibrancy: "under-window",
    visualEffectState: "followWindow",
    backgroundColor: PAPER,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: DEV,
    },
  });
  const w = win;
  if (s.maximized) w.maximize();
  trackState(w);
  menuReady = false;

  const wc = w.webContents;
  w.once("ready-to-show", () => w.show());
  wc.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) wc.loadURL(url);
    else openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (isLocal(url) || url.startsWith("data:")) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.on("did-navigate", () => (menuReady = false)); // new document: wait for it to subscribe again
  wc.on("did-finish-load", () => {
    if (pendingFirst.get(wc.id) && isLocal(wc.getURL())) {
      pendingFirst.delete(wc.id);
      wc.navigationHistory.clear(); // the splash is not a page you can go Back to
    }
  });
  wc.on("context-menu", (_e, p) => contextMenu(wc, p));
  const focus = (f) => () => !wc.isDestroyed() && wc.send("lambda:focus", f);
  w.on("focus", focus(true));
  w.on("blur", focus(false));
  w.on("closed", () => {
    if (win === w) win = null;
    pendingFirst.delete(wc.id);
  });

  // server already up (window reopened from the dock): go straight to the app, no splash
  if (ready && origin && !error) w.loadURL(`${origin}/`);
  else w.loadURL(splash(error));
  return w;
}

// ---------- menu ----------

function buildMenu() {
  const template = [
    {
      label: "lambda",
      submenu: [
        { role: "about", label: "About lambda" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Cmd+,", click: go("/settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: "Hide lambda" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: "Quit lambda" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Feature", accelerator: "Cmd+N", click: () => send({ type: "new-feature" }) },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Find…", accelerator: "Cmd+F", click: () => send({ type: "find" }) },
        { type: "separator" },
        { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
      ],
    },
    {
      label: "View",
      submenu: [
        // a stray ⌘R would wipe drafts and replay entrances: reload is a dev-only tool
        ...(DEV ? [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }] : []),
        { role: "resetZoom", label: "Actual Size" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Features", accelerator: "Cmd+1", click: go("/") },
        { label: "Sources", accelerator: "Cmd+2", click: go("/sources") },
        { label: "Settings", accelerator: "Cmd+3", click: go("/settings") },
        { type: "separator" },
        { label: "Back", accelerator: "Cmd+[", click: () => navStep(-1) },
        { label: "Forward", accelerator: "Cmd+]", click: () => navStep(1) },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Open Data Folder", click: () => shell.openPath(dataDir()) },
        { label: "Open Server Log", click: () => shell.openPath(logFile()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Back/Forward only between app pages — never onto the splash or anything else
function navStep(step) {
  const h = win?.webContents.navigationHistory;
  if (!h || !h.canGoToOffset(step)) return;
  const target = h.getEntryAtIndex(h.getActiveIndex() + step);
  if (target && isLocal(target.url)) h.goToOffset(step);
}

// ---------- verification runs: dock badge + notifications (main process, so they work windowless) ----------

function getJson(p) {
  return new Promise((resolve) => {
    if (!origin || !ready) return resolve(null);
    const req = http.get(`${origin}${p}`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(10000, () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

let runTimer = null;
let runPrev = null; // Map id → {id, featureId}

function setBadge(n) {
  app.dock?.setBadge(n ? String(n) : "");
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isFocused() && win.isVisible()) return; // only when you've looked away
  const n = new Notification({ title: String(title).slice(0, 120), body: String(body ?? "").slice(0, 240) });
  n.on("click", () => {
    if (!win || win.isDestroyed()) createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    onClick?.();
  });
  n.show();
}

async function runFinished(a) {
  const f = await getJson(`/api/features/${encodeURIComponent(a.featureId)}`);
  const run = f?.runs?.find((r) => r.id === a.id);
  if (!f || !run) return;
  const story = f.stories?.find((s) => s.id === run.storyId);
  const what = story ? `as ${story.role}, ${story.want}` : f.title;
  const mark = run.status === "passed" ? "✓ passed" : run.status === "failed" ? "✗ failed" : "⚠ errored";
  notify(`${mark} — ${f.title}`, what, () => send({ type: "navigate", path: `/f/${encodeURIComponent(f.id)}` }));
}

async function runTick() {
  runTimer = null;
  const body = await getJson("/api/runs");
  if (body && Array.isArray(body.active)) {
    const now = new Map(body.active.map((a) => [a.id, a]));
    setBadge(now.size);
    if (runPrev) for (const [id, a] of runPrev) if (!now.has(id)) runFinished(a);
    runPrev = now;
  }
  if (!ready || quitting) return;
  // quick while something runs or you're looking at the app; lazy when idle in the dock
  const active = runPrev?.size > 0;
  const looking = win && !win.isDestroyed() && win.isVisible() && win.isFocused();
  runTimer = setTimeout(runTick, active ? 2500 : looking ? 4000 : 20000);
}
function startRunWatch() {
  if (runTimer) clearTimeout(runTimer);
  runTick();
}
function stopRunWatch() {
  if (runTimer) clearTimeout(runTimer);
  runTimer = null;
  runPrev = null;
  setBadge(0);
}

// ---------- renderer bridge ----------

const fromUs = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents && isLocal(e.senderFrame?.url ?? "");

// in-page "done" nudges (stories / flows generated)
ipcMain.on("lambda:notify", (e, msg) => {
  if (!fromUs(e)) return;
  notify(msg?.title ?? "lambda", msg?.body ?? "");
});

// the dock badge is owned by the run watcher; a page asking means "something changed — look now"
ipcMain.on("lambda:badge", (e) => {
  if (fromUs(e) && ready) startRunWatch();
});

ipcMain.on("lambda:menu-ready", (e) => {
  if (fromUs(e)) flushMenu();
});

// ---------- lifecycle ----------

app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return void createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  app.setAboutPanelOptions({
    applicationName: "lambda",
    applicationVersion: app.getVersion(),
    credits: "design, review and verify — before the agents build",
  });
  // no camera/mic/geo prompts from the page
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  buildMenu();
  createWindow();
  await boot();
  if (ready) startRunWatch();
});

app.on("activate", () => {
  if (!win || win.isDestroyed()) createWindow();
  else win.show();
});

// mac convention: closing the window keeps the app (and server, and run notifications) alive in the dock
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  quitting = true;
  stopRunWatch();
  stopServer();
});
process.on("exit", stopServer);
