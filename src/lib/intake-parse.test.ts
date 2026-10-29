import { describe, expect, it } from "vitest";
import { parseReply, parseStreamLine, toolLine, validateBrief, visibleText } from "./intake-parse";

const BRIEF = {
  summary: "owners invite teammates by email; invitees join the workspace.",
  roles: ["owner", "invitee"],
  inScope: ["send invite", "accept link"],
  outOfScope: ["sso"],
  decisions: [{ q: "who invites?", a: "owners + admins" }],
  openQuestions: ["expired link copy"],
  surfaces: ["/settings/members", "invites table"],
  pieces: [
    { title: "send invite", why: "owners can invite", scope: ["invite form", "email"] },
    { title: "join + expiry", why: "invitees land in workspace", scope: ["accept route"] },
  ],
};

describe("parseReply", () => {
  it("pulls ask blocks out of the text (multi-line and inline fences)", () => {
    const raw = [
      "members live in `src/app/members/page.tsx`. invites don't exist yet.",
      "",
      "```lambda-ask",
      '{"question": "who can send invites?", "options": ["owners only", "owners + admins"], "multi": false}',
      "```",
      '```lambda-ask {"question": "what happens on expiry?", "options": ["resend", "dead link", "resend"]}```',
      "",
      "",
      "assuming email invites only.",
    ].join("\n");
    const r = parseReply(raw);
    expect(r.asks).toEqual([
      { question: "who can send invites?", options: ["owners only", "owners + admins"], multi: false },
      { question: "what happens on expiry?", options: ["resend", "dead link"], multi: false },
    ]);
    expect(r.text).toBe("members live in `src/app/members/page.tsx`. invites don't exist yet.\n\nassuming email invites only.");
    expect(r.brief).toBeUndefined();
    expect(r.briefError).toBeUndefined();
  });

  it("caps asks at 3 and drops duplicates / garbage", () => {
    const ask = (q: string) => "```lambda-ask\n" + JSON.stringify({ question: q, options: ["a", "b"] }) + "\n```";
    const r = parseReply([ask("one?"), ask("one?"), "```lambda-ask\nnot json\n```", ask("two?"), ask("three?"), ask("four?")].join("\n"));
    expect(r.asks.map((a) => a.question)).toEqual(["one?", "two?", "three?"]);
    expect(r.text).toBe("");
  });

  it("validates a brief block", () => {
    const r = parseReply(`clear. shaping it.\n\n\`\`\`lambda-brief\n${JSON.stringify(BRIEF, null, 1)}\n\`\`\``);
    expect(r.text).toBe("clear. shaping it.");
    expect(r.brief?.pieces.map((p) => p.title)).toEqual(["send invite", "join + expiry"]);
    expect(r.brief?.decisions).toEqual([{ q: "who invites?", a: "owners + admins" }]);
  });

  it("fills missing lists, trims, and keeps at most 5 pieces", () => {
    const v = validateBrief({ summary: "  x  ", pieces: Array.from({ length: 7 }, (_, i) => ({ title: ` p${i} ` })) });
    expect("brief" in v && v.brief).toMatchObject({ summary: "x", roles: [], inScope: [], decisions: [], surfaces: [] });
    expect("brief" in v && v.brief.pieces).toHaveLength(5);
    expect("brief" in v && v.brief.pieces[0]).toEqual({ title: "p0", why: "", scope: [] });
  });

  it("reports an invalid brief instead of dropping it silently", () => {
    expect(parseReply('```lambda-brief\n{"summary": "x", "pieces": []}\n```').briefError).toMatch(/at least one piece/);
    expect(parseReply("```lambda-brief\n{oops\n```").briefError).toMatch(/not valid JSON/);
    expect(parseReply('```lambda-brief\n{"pieces": [{"title": "a"}]}\n```').briefError).toMatch(/summary/);
  });

  it("tolerates prose around the JSON inside the fence", () => {
    const r = parseReply("```lambda-brief\nhere it is:\n" + JSON.stringify(BRIEF) + "\n```");
    expect(r.brief?.summary).toBe(BRIEF.summary);
  });
});

describe("lambda-issue blocks", () => {
  it("collects valid issues, drops junk, keeps prose", () => {
    const raw = [
      "renewals read `billing.py`.",
      '```lambda-issue\n{"title": "renewal uses list price not quote", "detail": "billing.py:88", "kind": "bug"}\n```',
      '```lambda-issue {"title": "", "kind": "bug"}```',
      '```lambda-issue {"title": "trial expiry has no email", "kind": "weird"}```',
      '```lambda-issue {"title": "renewal uses list price not quote", "kind": "bug"}```',
    ].join("\n");
    const r = parseReply(raw);
    expect(r.text).toBe("renewals read `billing.py`.");
    expect(r.issues).toEqual([
      { title: "renewal uses list price not quote", detail: "billing.py:88", kind: "bug" },
      { title: "trial expiry has no email", kind: "improvement" },
    ]);
    expect(visibleText(raw).trim()).toBe("renewals read `billing.py`."); // streaming view hides the blocks too
  });
});

describe("visibleText", () => {
  it("hides finished blocks, an unclosed fence, and a half-typed opener", () => {
    expect(visibleText('found it.\n```lambda-ask\n{"question":"a?","options":[]}\n```\nok')).toBe("found it.\n\nok");
    expect(visibleText('found it.\n```lambda-ask\n{"question":"wh')).toBe("found it.\n");
    expect(visibleText("found it.\n``")).toBe("found it.\n");
    expect(visibleText("found it.\n```lamb")).toBe("found it.\n");
    expect(visibleText("use `x` here")).toBe("use `x` here");
  });
});

describe("parseStreamLine", () => {
  const cwd = "/data/worktrees/abc";
  const L = (o: unknown) => parseStreamLine(JSON.stringify(o), cwd);

  it("session init", () => {
    expect(L({ type: "system", subtype: "init", session_id: "s-1", tools: [] })).toEqual([{ kind: "session", sessionId: "s-1" }]);
  });

  it("partial text deltas + message boundaries", () => {
    expect(L({ type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null })).toEqual([{ kind: "message" }]);
    expect(L({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } })).toEqual([
      { kind: "text", delta: "hi" },
    ]);
    expect(L({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } })).toEqual([]);
    // subagent stream is not the reply
    expect(L({ type: "stream_event", parent_tool_use_id: "t1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } })).toEqual([]);
  });

  it("assistant messages → tool trace lines + full text", () => {
    const ev = L({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "let me look." },
          { type: "tool_use", name: "Read", input: { file_path: `${cwd}/src/app/members/page.tsx` } },
          { type: "tool_use", name: "Grep", input: { pattern: "invite", path: `${cwd}/src` } },
        ],
      },
    });
    expect(ev).toEqual([
      { kind: "tool", line: "reading …/app/members/page.tsx" },
      { kind: "tool", line: "searching “invite” in src" },
      { kind: "assistant", text: "let me look." },
    ]);
  });

  it("result lines", () => {
    expect(L({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s" })).toEqual([{ kind: "result", ok: true, text: "done" }]);
    expect(L({ type: "result", subtype: "error_max_turns", is_error: true })).toEqual([{ kind: "result", ok: false, text: "", error: "error_max_turns" }]);
  });

  it("ignores junk", () => {
    expect(parseStreamLine("not json")).toEqual([]);
    expect(L({ type: "user", message: { content: [{ type: "tool_result" }] } })).toEqual([]);
  });

  it("tool lines stay short", () => {
    expect(toolLine("Glob", { pattern: "src/**/*.tsx" })).toBe("listing src/**/*.tsx");
    expect(toolLine("mcp__linear__get_issue", {})).toBe("using get_issue");
    expect(toolLine("Read", { file_path: "/elsewhere/a.ts" }, cwd)).toBe("reading /elsewhere/a.ts");
  });
});
