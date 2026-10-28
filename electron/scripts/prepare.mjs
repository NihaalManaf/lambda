// After `next build`: make .next/standalone self-contained for the mac app (static + public in, data out).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const sa = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(sa, "server.js"))) throw new Error("no .next/standalone/server.js — is output: 'standalone' set?");

const copy = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
};
copy(path.join(root, ".next", "static"), path.join(sa, ".next", "static"));
copy(path.join(root, "public"), path.join(sa, "public"));

// never ship user data (settings.json holds test passwords), a stray electron, or source the tracer
// pulled in through dynamic repo paths (path.resolve(repo, f) in schema/queue code)
for (const p of ["data", "dist", "electron", "src", "node_modules/electron", "node_modules/electron-builder"])
  fs.rmSync(path.join(sa, p), { recursive: true, force: true });

// serverExternalPackages are only partially traced (playwright loads browsers.json etc. dynamically):
// ship them whole so screenshots / captures work inside the app
// pgsql-parser closure (npm ls --all pgsql-parser): libpg-query ships its .wasm, loaded at runtime
for (const pkg of [
  "playwright", "playwright-core", "sharp", "@img",
  "libpg-query", "pgsql-parser", "pgsql-deparser", "@pgsql/types", "@pgsql/quotes",
])
  copy(path.join(root, "node_modules", pkg), path.join(sa, "node_modules", pkg));

fs.copyFileSync(path.join(root, "electron", "app", "boot.cjs"), path.join(sa, "lambda-boot.cjs"));

console.log("standalone ready:", sa);
