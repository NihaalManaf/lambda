import type { ReactNode } from "react";

// `code` spans and **bold** without a markdown dependency; everything else stays plain text.
// Shared by the intake conversation and the ask-lambda thread.
export function inline(text: string, codeClass = "text-[0.9em]"): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((p, i) =>
    p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
      <code key={i} className={`rounded-md bg-paper-2 px-1 py-px font-mono text-ink ${codeClass}`}>
        {p.slice(1, -1)}
      </code>
    ) : p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
      <strong key={i} className="font-semibold text-ink">
        {p.slice(2, -2)}
      </strong>
    ) : (
      p
    ),
  );
}
