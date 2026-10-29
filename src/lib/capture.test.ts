import { describe, expect, it, vi } from "vitest";

vi.mock("playwright", () => ({ chromium: {} }));

import { maskText } from "./capture";

describe("maskText", () => {
  it("masks emails, phone numbers and long digit runs, keeps ordinary copy", () => {
    expect(maskText("Jane Doe · jane.doe+x@acme.co.uk")).toBe("Jane Doe · [email]");
    expect(maskText("call +1 (415) 555-0134 now")).toBe("call [number] now");
    expect(maskText("order 1234567")).toBe("order [number]");
    expect(maskText("Invite 3 members")).toBe("Invite 3 members");
  });
});
