import type { Metadata } from "next";
import { Setup } from "@/components/setup/Setup";

export const metadata: Metadata = { title: "setup · lambda" };

export default function SetupPage() {
  return <Setup />;
}
