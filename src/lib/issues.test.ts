import { describe, expect, it, vi } from "vitest";

const generate = vi.fn();
vi.mock("./llm", () => ({ generate: (...a: unknown[]) => generate(...a) }));

import { DELETE, GET, PATCH, POST } from "@/app/api/features/[id]/issues/route";
import { POST as build } from "@/app/api/features/[id]/issues/build/route";
import { createFeature, getFeature } from "./store";
import { cleanIssue } from "./issues";
import { featureMode, type Feature, type FeatureView } from "./types";

// Issues API + build-from-issues (model mocked). LAMBDA_DATA_DIR is a temp dir (vitest.config.ts).
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, url = "http://x") => new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
const add = async (fid: string, body: unknown) => (await (await POST(req("POST", body), ctx(fid))).json()) as FeatureView;

describe("issues", () => {
  it("cleanIssue: title capped at 10 words, bad ref / kind dropped", () => {
    const i = cleanIssue({ title: "one two three four five six seven eight nine ten eleven", kind: "nope", ref: { tab: "x", id: "s1" } });
    expect(i?.title.split(" ")).toHaveLength(10);
    expect(i?.kind).toBe("improvement");
    expect(i?.ref).toBeUndefined();
    expect(cleanIssue({ title: "  " })).toBeNull();
    expect(cleanIssue({ title: "t", ref: { tab: "schema", id: "public.team_invites", label: "team_invites" } })?.ref?.id).toBe("public.team_invites");
  });

  it("collects on understand features only; dedupes open ones; edit / drop / restore / delete", async () => {
    const b = await createFeature("build one", "");
    expect((await POST(req("POST", { title: "x" }), ctx(b.id))).status).toBe(409);

    const u = await createFeature("how billing works", "", "intake", "understand");
    let v = await add(u.id, { title: "renewal shows wrong amount", kind: "bug" });
    v = await add(u.id, { title: "renewal shows wrong amount", kind: "bug" }); // double click
    expect(v.issues).toHaveLength(1);
    v = await add(u.id, { title: "flag me", source: "pin", ref: { tab: "stories", id: "st_1", label: "buy a plan" } });
    const [a, pinned] = v.issues!;
    expect(pinned.source).toBe("pin");
    expect(pinned.ref?.tab).toBe("stories");
    expect(a.source).toBe("manual");

    v = (await (await PATCH(req("PATCH", { issueId: a.id, title: "renewal amount wrong", status: "dropped" }), ctx(u.id))).json()) as FeatureView;
    expect(v.issues!.find((i) => i.id === a.id)).toMatchObject({ title: "renewal amount wrong", status: "dropped" });
    v = (await (await PATCH(req("PATCH", { issueId: a.id, status: "open" }), ctx(u.id))).json()) as FeatureView;
    expect(v.issues!.find((i) => i.id === a.id)!.status).toBe("open");
    v = (await (await DELETE(req("DELETE", undefined, `http://x?issueId=${pinned.id}`), ctx(u.id))).json()) as FeatureView;
    expect(v.issues).toHaveLength(1);
    const listed = (await (await GET(req("GET"), ctx(u.id))).json()) as { issues: unknown[] };
    expect(listed.issues).toHaveLength(1);
  });

  it("build: a new build feature from the picked issues, linked both ways; issues move to in build", async () => {
    const u = await createFeature("how billing works", "plans sync from stripe", "intake", "understand");
    const v = await add(u.id, { title: "renewal shows wrong amount", kind: "bug", detail: "uses list price, not the quote" });
    const v2 = await add(u.id, { title: "no trial expiry email", kind: "improvement" });
    const [a, c] = v2.issues!;
    expect(v.issues).toHaveLength(1);

    generate.mockResolvedValueOnce({ title: "fix renewal amount", brief: "renewals should use the quoted amount." });
    const res = await build(req("POST", { issueIds: [a.id] }), ctx(u.id));
    const { id } = (await res.json()) as { id: string };
    const nf = getFeature(id) as Feature;
    expect(featureMode(nf)).toBe("build");
    expect(nf.title).toBe("fix renewal amount");
    expect(nf.brief).toContain("renewal shows wrong amount");
    expect(nf).toMatchObject({ fromFeature: u.id, issueIds: [a.id], phase: "intake" });
    expect(nf.context[0].url).toBe(`/f/${u.id}`);

    const src = getFeature(u.id)!;
    expect(src.issues!.find((i) => i.id === a.id)).toMatchObject({ status: "in build", build: id });
    expect(src.issues!.find((i) => i.id === c.id)!.status).toBe("open");
    expect(src.builds).toEqual([expect.objectContaining({ featureId: id, issueIds: [a.id] })]);
    // already in a build: can't start another from it, and drop doesn't pull it out
    expect((await build(req("POST", { issueIds: [a.id] }), ctx(u.id))).status).toBe(400);
    await PATCH(req("PATCH", { issueId: a.id, status: "dropped" }), ctx(u.id));
    expect(getFeature(u.id)!.issues!.find((i) => i.id === a.id)!.status).toBe("in build");

    generate.mockRejectedValueOnce(new Error("no key")); // no model: the issues are the brief
    const { id: id2 } = (await (await build(req("POST", { issueIds: [c.id] }), ctx(u.id))).json()) as { id: string };
    expect(getFeature(id2)!.title).toBe("no trial expiry email");
  });
});
