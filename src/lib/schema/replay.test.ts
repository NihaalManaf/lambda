import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { cloneModel } from "./apply";
import { type Replayed, headOf, migrationView, modelAt, replay, tableView } from "./replay";
import type { MigrationView } from "./types";

const REPO = process.env.LAMBDA_TEST_REPO ?? ""; // real-repo fixtures run only when set
const CFG = { repo: REPO, dirs: ["migrations", "alerts-monitoring/migrations"], baseline: "" };

describe.skipIf(!fs.existsSync(`${REPO}/migrations`))("replay against the real repo", () => {
  let r: Replayed;
  let coldMs = 0;
  beforeAll(async () => {
    const t0 = performance.now();
    r = await replay(CFG);
    coldMs = performance.now() - t0;
  });
  const view = (id: string) => migrationView(r, id)!;
  const tbl = (v: MigrationView, id: string) => v.graph.tables.find((t) => t.id === id)!;
  const rules = (v: MigrationView) => v.graph.risks.map((x) => x.rule);

  it("replays 318 files with zero parse errors, fast", async () => {
    expect(r.files).toHaveLength(318);
    expect(r.files.filter((f) => f.file.startsWith("alerts-monitoring"))).toHaveLength(6);
    expect(r.metas.filter((m) => m.parseError)).toEqual([]);
    expect(coldMs).toBeLessThan(400);
    const t0 = performance.now();
    expect(await replay(CFG)).toBe(r);
    expect(performance.now() - t0).toBeLessThan(10);
    const t1 = performance.now();
    modelAt(r, 200);
    expect(performance.now() - t1).toBeLessThan(15);
    expect(JSON.stringify(headOf(r)).length).toBeLessThan(150_000);
  });

  it("head has the live tables", () => {
    const fromMigrations = Object.values(r.head.tables).filter((t) => t.origin === "migration");
    expect(fromMigrations.length).toBeGreaterThanOrEqual(176);
    expect(r.head.tables["public.team_domain_registrant"]).toBeUndefined();
    for (const t of ["advisor_report", "advisor_report_row", "advisor_report_suppression"])
      expect(r.head.tables[`public._trash_${t}_20260605`]).toBeDefined();
    expect(r.head.tables["alerts_internal.media_queue"]).toBeDefined();
  });

  it("orders 8-digit prefixes before 14-digit ones of the same day, flags shared prefixes", () => {
    const ids = r.files.map((f) => f.id);
    for (const [i, f] of r.files.entries()) {
      if (f.prefix.length !== 8) continue;
      const firstLong = ids.findIndex((x) => x.startsWith(f.prefix) && /^\d{14}/.test(x));
      if (firstLong >= 0) expect(i).toBeLessThan(firstLong);
    }
    const dup = r.metas.filter((m) => m.id.startsWith("20260915190000_"));
    expect(dup).toHaveLength(2);
    expect(dup.every((m) => m.dupPrefix)).toBe(true);
  });

  it("add column on a baseline table", () => {
    const v = view("20260311_add_allow_smoothing_to_template.sql");
    const t = tbl(v, "public.template");
    expect(t).toMatchObject({ diff: "changed", origin: "stub" });
    expect(t.cols.filter((c) => c.diff === "added").map((c) => c.name)).toEqual(["allow_smoothing"]);
    expect(rules(v)).toContain("baseline-unknown");
  });

  it("new table with fks, rls, policy, partial unique index", () => {
    const v = view("20260915220000_refund_requests.sql");
    const t = tbl(v, "public.refund_requests");
    expect(t.diff).toBe("added");
    expect(t.rls).toBe(true);
    const model = r.head.tables["public.refund_requests"];
    expect(model.fks.some((f) => f.refTable === "public.users")).toBe(true);
    expect(model.policies).toHaveLength(1);
    expect(model.indexes.some((i) => i.unique && i.partial)).toBe(true);
    expect(tbl(v, "public.users")?.diff).toBe("context");
    expect(v.graph.edges.some((e) => e.from === "public.refund_requests" && e.to === "public.users")).toBe(true);
  });

  it("destructive column drop behind a safety guard", () => {
    const v = view("20260616140000_drop_dead_trial_auto_profile_team_columns.sql");
    expect(tbl(v, "public.team").cols.filter((c) => c.diff === "removed").length).toBeGreaterThanOrEqual(2);
    expect(v.graph.risks.find((x) => x.rule === "drop-column")?.level).toBe("bad");
    expect(rules(v)).toContain("safety-check");
  });

  it("drop table", () => {
    const v = view("20260428000000_drop_team_domain_registrant.sql");
    expect(tbl(v, "public.team_domain_registrant").diff).toBe("removed");
    expect(rules(v)).toContain("drop-table");
  });

  it("enum-style check change", () => {
    const v = view("20260629143000_add_linkedin_connection_request_note_mode.sql");
    const t = tbl(v, "public.linkedin_accounts");
    const added = t.cols.filter((c) => c.diff === "added");
    expect(added).toHaveLength(1);
    expect(added[0].enumValues?.some((e) => e.diff === "added")).toBe(true);
  });

  it("DO blocks: ddl inside guards, dynamic, raise", () => {
    const i = r.files.findIndex((f) => f.id === "20260709090000_harden_linkedin_outreach_production_safety.sql");
    const ops = r.effects[i].ops;
    expect(r.effects[i].error).toBeUndefined();
    const fromDo = ops.filter((o) => o.op === "add_check" || o.op === "add_fk");
    expect(fromDo.length).toBeGreaterThanOrEqual(1);
    expect(ops.filter((o) => o.op === "dynamic").length).toBeGreaterThanOrEqual(1);
    expect(ops.filter((o) => o.op === "guard").length).toBeGreaterThanOrEqual(1);
    expect(r.metas[i].dynamic).toBeGreaterThanOrEqual(1);
  });

  it("big DO block parses", () => {
    const i = r.files.findIndex((f) => f.id === "20260903150000_sendblue_relay_reliability.sql");
    expect(r.effects[i].error).toBeUndefined();
    expect(() => view("20260903150000_sendblue_relay_reliability.sql")).not.toThrow();
  });

  it("table renames", () => {
    const v = view("20260605180100_trash_advisor_report_plan_b.sql");
    const renamed = v.graph.tables.filter((t) => t.diff === "renamed");
    expect(renamed).toHaveLength(3);
    expect(renamed.every((t) => t.from?.startsWith("advisor_report"))).toBe(true);
    expect(rules(v)).toContain("rename");
  });

  it("every view stays within caps and labels stay short", () => {
    for (const m of r.metas) {
      expect(m.title.split(" ").length).toBeLessThanOrEqual(4);
      const v = view(m.id);
      expect(v.graph.tables.length).toBeLessThanOrEqual(8);
      for (const x of v.graph.risks) expect(x.why.split(" ").length).toBeLessThanOrEqual(12);
      for (const o of v.opsSummary) expect(o.text.split(" ").length).toBeLessThanOrEqual(4);
    }
  });

  it("modelAt matches a straight fold", () => {
    const i = 100;
    const a = modelAt(r, i);
    const b = cloneModel(modelAt(r, i - 1));
    expect(Object.keys(a.tables).length).toBeGreaterThan(0);
    expect(Object.keys(modelAt(r, r.files.length - 1).tables).sort()).toEqual(Object.keys(r.head.tables).sort());
    expect(b).not.toBe(a);
  });

  it("table view: head + neighbours + history", () => {
    const v = tableView(r, "team")!;
    expect(v.graph.tables[0]).toMatchObject({ id: "public.team", diff: "same" });
    expect(v.graph.tables.length).toBeGreaterThan(1);
    expect(v.history.length).toBeGreaterThan(5);
  });
});
