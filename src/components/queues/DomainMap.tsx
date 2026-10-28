"use client";

import type { QGNode, QueueGraph } from "@/lib/queues/types";
import QueueCanvas from "./QueueCanvas";

// System overview: one card per domain on a grid; click one to open its view.

export const domainId = (n: QGNode) => n.id.replace(/^(?:d|domain)[:/]/, "");

export default function DomainMap({
  graph,
  onOpen,
  onPrefetch,
}: {
  graph: QueueGraph;
  onOpen: (domain: string, label: string, at: { x: number; y: number }) => void;
  onPrefetch?: (domain: string) => void;
}) {
  return (
    <QueueCanvas
      graph={graph}
      minH={200}
      maxH={680}
      onSelect={(n, at) => n.kind === "domain" && onOpen(domainId(n), n.label, at)}
      onHoverNode={onPrefetch && ((n) => n.kind === "domain" && onPrefetch(domainId(n)))}
    />
  );
}
