// Edit contract shared by direct-manipulation UI and the feature chat.
// Every change to a feature's artifacts is one of these ops; owners implement apply* in their lib:
//   story ops   → src/lib/stories.ts  applyStoryOp(feature, op)
//   flow ops    → src/lib/flows.ts    applyFlowOp(feature, op)   (enforces MAX_FLOW_NODES)
//   context ops → src/lib/autocontext.ts applyContextOp(feature, op)
// apply* mutate the feature in place (call inside updateFeature) and return a ChangeNote for the chat.

import type { AcceptanceDraft } from "./ops-drafts";
import type { FlowLens, FlowNodeKind, Priority } from "./types";

export type StoryOp =
  | { op: "add_story"; role: string; want: string; soThat: string; priority?: Priority; sliceId?: string; acceptance?: AcceptanceDraft[] }
  | { op: "update_story"; storyId: string; role?: string; want?: string; soThat?: string; priority?: Priority; sliceId?: string }
  | { op: "remove_story"; storyId: string }
  | { op: "add_criterion"; storyId: string; criterion: AcceptanceDraft }
  | { op: "update_criterion"; storyId: string; criterionId: string; criterion: Partial<AcceptanceDraft> }
  | { op: "remove_criterion"; storyId: string; criterionId: string }
  | { op: "add_slice"; title: string; why: string; after?: string }
  | { op: "rename_slice"; sliceId: string; title: string };

export type FlowOp =
  | { op: "rename_node"; setId: string; chartId: string; nodeId: string; label: string }
  | { op: "set_node_kind"; setId: string; chartId: string; nodeId: string; kind: FlowNodeKind }
  | { op: "add_node"; setId: string; chartId: string; label: string; kind: FlowNodeKind; after?: string; edgeLabel?: string }
  | { op: "remove_node"; setId: string; chartId: string; nodeId: string } // reconnects in→out edges
  | { op: "add_edge"; setId: string; chartId: string; from: string; to: string; label?: string }
  | { op: "update_edge"; setId: string; chartId: string; edgeId: string; label?: string }
  | { op: "remove_edge"; setId: string; chartId: string; edgeId: string }
  | { op: "add_edge_case"; setId: string; chartId: string; nodeId: string; text: string }
  | { op: "remove_edge_case"; setId: string; chartId: string; edgeCaseId: string }
  | { op: "refine_chart"; setId: string; chartId: string; instruction: string } // LLM rewrite of one chart
  | { op: "draw_lens"; lens: FlowLens; focus?: string }; // generate a new set

export type ContextOp =
  | { op: "attach"; kind: "slack" | "linear" | "session" | "note"; title: string; excerpt: string; url?: string }
  | { op: "detach"; refId: string }
  | { op: "rediscover" };

export type FeatureOp = StoryOp | FlowOp | ContextOp | { op: "update_brief"; brief: string } | { op: "rename_feature"; title: string };

// What the chat shows as a compact change card ("+ story", "~ node", "− edge case").
export interface ChangeNote {
  sign: "+" | "~" | "−";
  what: "story" | "criterion" | "slice" | "node" | "edge" | "edge case" | "chart" | "flow set" | "context" | "brief" | "title";
  label: string; // <= 6 words
  tab: "stories" | "flows" | "context" | "overview";
  ref?: string; // id to highlight/scroll to
  scope?: string; // container of ref when ref ids aren't globally unique (flow node/edge ids are per chart → chart id)
}
