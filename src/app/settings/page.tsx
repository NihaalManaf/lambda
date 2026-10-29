import os from "node:os";
import { DATA_DIR, getSettings } from "@/lib/store";
import { settingsView } from "@/components/settings/view";
import SettingsForm from "@/components/settings/SettingsForm";
import LambdaMd from "@/components/settings/LambdaMd";
import StackSettings from "@/components/settings/StackSettings";
import { getLambdaMd } from "@/lib/lambdamd";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 pb-24 pt-12">
      <div className="eyebrow mb-3">settings</div>
      <h1 className="display text-5xl md:text-6xl">
        the <span className="italic">control</span> room
      </h1>
      {/* one store for the web app and the mac app: show which one is live */}
      <p className="mt-4 font-mono text-[12px] text-grey" title={DATA_DIR}>
        data · {DATA_DIR.replace(os.homedir(), "~")}
      </p>
      <SettingsForm initial={settingsView(getSettings())} />
      <LambdaMd initial={getLambdaMd()} />
      <StackSettings />
    </main>
  );
}
