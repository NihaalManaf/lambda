"use client";

import { createContext, memo, useContext } from "react";
import { EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { useReducedMotion } from "motion/react";
import BadgeRow from "@/components/viz/BadgeRow";
import { DIFF, edgeStroke } from "@/components/viz/diffStyle";
import type { QEdge } from "./queueLayout";

// A queue edge: smoothstep path coloured by diff, badges at the midpoint, and message dots that ride
// the path with SMIL <animateMotion> (no React re-renders, no layout). Retries send a red dot back
// every third pass. Paused or reduced-motion → the same dots, frozen at even spacing.

export const PlayCtx = createContext(false);

// self-publish or a back edge (consumer re-publishing the channel that feeds it): an arc over the
// nodes from the right port back to the left port, lifted higher the further it has to travel
function loopPath(sx: number, sy: number, tx: number, ty: number): [string, number, number] {
  const lift = 58 + Math.min(80, Math.abs(sx - tx) * 0.12);
  const top = Math.min(sy, ty) - lift;
  return [`M${sx},${sy} C${sx + 48},${top} ${tx - 48},${top} ${tx},${ty}`, (sx + tx) / 2, Math.min(sy, ty) - lift * 0.75];
}

function Dots({ path, n, speed, retry, live }: { path: string; n: number; speed: number; retry: boolean; live: boolean }) {
  const dur = `${speed}s`;
  // blue with a paper halo: reads against ink, lilac pills and the dotted paper alike
  const dot = { r: 4, stroke: "var(--paper)", strokeWidth: 1.5 };
  return (
    <g className="pointer-events-none">
      {Array.from({ length: n }, (_, i) => {
        const at = (i + 0.5) / n;
        return (
          <circle key={i} {...dot} fill="var(--blue)">
            {live ? (
              <animateMotion path={path} dur={dur} begin={`${-at * speed}s`} repeatCount="indefinite" />
            ) : (
              <animateMotion path={path} dur="0.001s" fill="freeze" keyPoints={`${at};${at}`} keyTimes="0;1" calcMode="linear" />
            )}
          </circle>
        );
      })}
      {retry && live && (
        <circle {...dot} fill="var(--bad)" opacity={0}>
          <animateMotion path={path} dur={`${speed * 3}s`} repeatCount="indefinite" keyPoints="1;1;0" keyTimes="0;0.6667;1" calcMode="linear" />
          <animate attributeName="opacity" values="0;1" keyTimes="0;0.6667" dur={`${speed * 3}s`} calcMode="discrete" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}

const LOOP_BADGE = { icon: "loop", title: "re-publishes to itself" } as const;

function MessageEdge({ source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<QEdge>) {
  const play = useContext(PlayCtx);
  const reduce = useReducedMotion();
  if (!data) return null;
  const arc = source === target || data.role === "loop" || targetX < sourceX - 8;
  const [path, ax, ay] = arc
    ? loopPath(sourceX, sourceY, targetX, targetY)
    : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  const callback = data.role === "callback";
  const look = DIFF[data.diff];
  const moving = data.dots > 0 && data.diff !== "removed";
  // with dots running, a plain edge steps back so the messages are what you see
  const quiet = moving && play && !reduce && data.diff === "same" && !callback;
  const badges = (data.role === "loop" ? [LOOP_BADGE, ...data.badges] : data.badges).slice(0, 2);
  // a straight edge carries its badges at the middle; a bent one just above its first run, clear of the
  // source port (never on the target's border); an arc at its top
  const at = arc
    ? { x: ax, y: ay, anchor: "-50%" }
    : Math.abs(sourceY - targetY) < 4
      ? { x: (sourceX + targetX) / 2, y: sourceY - 11, anchor: "-50%" }
      : { x: sourceX + 14, y: sourceY - 11, anchor: "0%" };
  return (
    <>
      <path
        d={path}
        fill="none"
        markerEnd={markerEnd}
        className="react-flow__edge-path"
        style={{
          stroke: callback ? "var(--bad)" : quiet ? "var(--grey)" : edgeStroke(data.diff),
          strokeWidth: quiet ? 1.1 : data.diff === "same" || data.diff === "context" ? 1.4 : 2,
          strokeDasharray: callback || look.dashed ? "5 4" : undefined,
          opacity: look.opacity,
          transition: "stroke 200ms var(--ease-out), stroke-width 200ms var(--ease-out)",
        }}
      />
      {moving && <Dots path={path} n={data.dots} speed={Math.max(0.6, data.speed || 2.5)} retry={data.retry} live={play && !reduce} />}
      {badges.length > 0 && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute rounded-full bg-paper px-0.5"
            style={{ transform: `translate(${at.anchor},-50%) translate(${at.x}px,${at.y}px)`, opacity: look.opacity }}
          >
            <BadgeRow badges={badges} max={2} />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default memo(MessageEdge);
