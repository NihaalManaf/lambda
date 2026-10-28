import "server-only";
import { keyStatus } from "@/lib/env";
import type { Settings } from "@/lib/types";
import { KEY_NAMES, type SettingsView } from "./types";

// Settings as the browser may see them: passwords masked, keys as booleans only.
export function settingsView(s: Settings): SettingsView {
  return {
    ...s,
    accounts: s.accounts.map((a) => ({ ...a, password: "", hasPassword: Boolean(a.password) })),
    keys: keyStatus(KEY_NAMES),
  };
}
