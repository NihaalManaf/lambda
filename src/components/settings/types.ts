import type { Settings, TestAccount } from "@/lib/types";

// Wire shape of GET/PUT /api/settings: passwords never leave the server.
export type MaskedAccount = Omit<TestAccount, "password"> & { password: string; hasPassword: boolean };
export type SettingsView = Omit<Settings, "accounts"> & { accounts: MaskedAccount[]; keys: Record<string, boolean> };

export const KEY_NAMES = ["ANTHROPIC_API_KEY", "LINEAR_API_KEY", "SLACK_BOT_TOKEN", "SLACK_TOKEN"];
export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];
