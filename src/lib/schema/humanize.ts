// Filename -> a <=4 word title: "20260629143000_add_linkedin_connection_request_note_mode.sql" -> "linkedin note mode"
const FILLER = new Set(["add", "adds", "to", "the", "a", "an", "of", "for", "on", "in", "into", "with", "and", "sql"]);

export function humanize(file: string): string {
  const base = file.replace(/^.*[\\/]/, "").replace(/\.sql$/i, "").replace(/^\d+[_-]?/, "");
  const words = base.split(/[_\-\s]+/).filter((w) => w && !FILLER.has(w.toLowerCase())).map((w) => w.toLowerCase());
  if (!words.length) return base || file;
  return (words.length > 4 ? [words[0], ...words.slice(-2)] : words).join(" ");
}
