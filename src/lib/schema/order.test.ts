import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { humanize } from "./humanize";
import { listMigrations } from "./order";

describe("order", () => {
  it("pads 8-digit prefixes, flags duplicate prefixes, reads extra dirs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    fs.mkdirSync(path.join(root, "m"));
    fs.mkdirSync(path.join(root, "x"));
    for (const f of ["20260310193000_b.sql", "20260310_a.sql", "20260311_c.sql", "20260915190000_d.sql", "20260915190000_e.sql", "notes.md"])
      fs.writeFileSync(path.join(root, "m", f), "");
    fs.writeFileSync(path.join(root, "x", "20260312_z.sql"), "");
    const files = listMigrations(root, ["m", "x", "missing"]);
    expect(files.map((f) => f.id)).toEqual(["20260310_a.sql", "20260310193000_b.sql", "20260311_c.sql", "20260312_z.sql", "20260915190000_d.sql", "20260915190000_e.sql"]);
    expect(files.filter((f) => f.dupPrefix).map((f) => f.id)).toEqual(["20260915190000_d.sql", "20260915190000_e.sql"]);
    expect(files[3].file).toBe(path.join("x", "20260312_z.sql"));
    expect(files[0].date).toBe("2026-03-10");
  });

  it("humanizes filenames to <= 4 words", () => {
    expect(humanize("20260629143000_add_linkedin_connection_request_note_mode.sql")).toBe("linkedin note mode");
    expect(humanize("20260311_add_allow_smoothing_to_template.sql")).toBe("allow smoothing template");
    expect(humanize("20260915220000_refund_requests.sql")).toBe("refund requests");
  });
});
