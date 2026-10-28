// Runs inside the server process (electron-as-node). Exits if lambda.app goes away without a clean
// quit (crash / force-kill). main.cjs spawns us detached, so we lead our own process group: take the
// whole group down (verification `claude -p` runs, playwright mcp, chromium) so no paid run is orphaned.
const parent = process.ppid;

function bail() {
  try {
    process.kill(-process.pid, "SIGTERM"); // our group, us included
  } catch {}
  setTimeout(() => process.exit(0), 500).unref();
}

setInterval(() => {
  let alive = process.ppid === parent;
  try {
    process.kill(parent, 0);
  } catch {
    alive = false;
  }
  if (!alive) bail();
}, 2000).unref();

require(process.env.LAMBDA_SERVER_ENTRY);
