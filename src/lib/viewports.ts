// Capture sizes for ui sketches. Client-safe (the capture bar picks one, the server captures at it).

export const VIEWPORTS = [
  { id: "desktop", name: "desktop", width: 1440, height: 900 },
  { id: "laptop", name: "laptop", width: 1280, height: 800 },
  { id: "tablet", name: "tablet", width: 834, height: 1112 },
  { id: "mobile", name: "mobile", width: 390, height: 844 },
] as const;

export type ViewportId = (typeof VIEWPORTS)[number]["id"];
export type Viewport = (typeof VIEWPORTS)[number];

export const DEFAULT_VIEWPORT: ViewportId = "laptop";

export const viewportOf = (vid: string | undefined | null): Viewport =>
  VIEWPORTS.find((v) => v.id === vid) ?? VIEWPORTS.find((v) => v.id === DEFAULT_VIEWPORT)!;

// older mockups carry only a width: match it to a preset, else assume a laptop-height first screen
export const foldOf = (m: { width: number; fold?: number }) => m.fold ?? VIEWPORTS.find((v) => v.width === m.width)?.height ?? 800;
