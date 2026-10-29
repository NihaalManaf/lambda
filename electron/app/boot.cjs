// Runs inside the server process (electron-as-node). Exits if lambda.app goes away without a clean
// quit (crash / force-kill). main.cjs spawns us detached, so we lead our own process group: take the
// whole group down (verification `claude -p` runs, playwright mcp, chromium) so no paid run is orphaned.
const parent = process.ppid;

// lambda's local stacks (src/lib/stack) run detached in their own groups: kill the pgids we recorded
function stackGroups() {
  const fs = require("node:fs");
  const dir = require("node:path").join(process.env.LAMBDA_DATA_DIR || "", "stacks");
  const out = [];
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".state.json"))) {
      const st = JSON.parse(fs.readFileSync(require("node:path").join(dir, f), "utf8"));
      if (st.ownerPid !== process.pid) continue;
      for (const s of st.services || []) if (s.pid > 1) out.push(s.pid);
      if (st.setupPid > 1) out.push(st.setupPid); // a setup step (cp -cR / npm ci) in flight
    }
  } catch {}
  return out;
}

function bail() {
  const stacks = process.env.LAMBDA_DATA_DIR ? stackGroups() : [];
  for (const pg of stacks)
    try {
      process.kill(-pg, "SIGTERM");
    } catch {}
  try {
    process.kill(-process.pid, "SIGTERM"); // our group, us included
  } catch {}
  setTimeout(() => {
    for (const pg of stacks)
      try {
        process.kill(-pg, "SIGKILL");
      } catch {}
    process.exit(0);
  }, 500).unref();
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
