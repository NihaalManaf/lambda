// Acceptance criterion as written by a person or the chat (ids assigned on apply).
export interface AcceptanceDraft {
  given: string;
  when: string;
  then: string;
  startPath: string;
  steps: string[];
  unverified?: string | null; // check stage only: a reason marks it, null / "" clears it
}
