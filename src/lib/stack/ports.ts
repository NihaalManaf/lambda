import net from "node:net";
import { RESERVED_PORTS } from "./plan";

// Free loopback ports for the stack. A port counts as free only when it can be bound on both 127.0.0.1 and
// the IPv6 wildcard (uvicorn --host :: / next dev bind those), and it's never one of the developer's usual ports.

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL"));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export async function portFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  return (await canBind(port, "127.0.0.1")) && (await canBind(port, "::"));
}

// an OS-picked ephemeral port (then re-checked on both stacks)
function ephemeral(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// n distinct free ports. preferred[i] is kept when still free (stable urls across restarts: cookies, logins).
export async function allocatePorts(n: number, opts: { preferred?: (number | undefined)[]; avoid?: number[] } = {}): Promise<number[]> {
  const avoid = new Set([...RESERVED_PORTS, ...(opts.avoid ?? [])]);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const want = opts.preferred?.[i];
    if (want && !avoid.has(want) && !out.includes(want) && (await portFree(want))) {
      out.push(want);
      continue;
    }
    for (let tries = 0; ; tries++) {
      if (tries > 50) throw new Error("no free port found");
      const p = await ephemeral();
      if (!avoid.has(p) && !out.includes(p) && !(opts.preferred ?? []).includes(p) && (await portFree(p))) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}
