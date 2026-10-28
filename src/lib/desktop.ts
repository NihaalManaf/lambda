// Bridge to the mac app (electron/app/preload.cjs). In a plain browser `window.lambda` is undefined
// and every helper here is a no-op, so the web build keeps working unchanged.

export type MenuAction =
  | { type: "navigate"; path: string }
  | { type: "new-feature" }
  | { type: "find" };

export interface LambdaDesktop {
  isDesktop: true;
  platform: string;
  notify(title: string, body?: string): void;
  setBadge(n: number): void;
  onMenu(cb: (action: MenuAction) => void): () => void;
}

declare global {
  interface Window {
    lambda?: LambdaDesktop;
  }
}

export const desktop = (): LambdaDesktop | undefined => (typeof window === "undefined" ? undefined : window.lambda);

// Native notification — main process only shows it when the window isn't focused.
export const notify = (title: string, body?: string) => desktop()?.notify(title, body);

export const NEW_FEATURE_EVENT = "lambda:new-feature";

// A run started or stopped: ask the mac app to refresh the dock badge now instead of on its next poll.
export const runsChanged = () => desktop()?.setBadge(-1);
