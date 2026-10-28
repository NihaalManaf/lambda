// Acceptance criterion as written by a person or the chat (ids assigned on apply).
export interface AcceptanceDraft {
  given: string;
  when: string;
  then: string;
  startPath: string;
  steps: string[];
}
