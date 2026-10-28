// Schema model + migration views. Pure types: no server-only, shared with the client.
import type { Badge, DiffState, IconName, Risk, RiskLevel } from "../types";

export interface Column { name: string; type: string; nullable: boolean; default?: string; pk?: boolean; generated?: boolean; comment?: string }
export interface Fk { name: string; cols: string[]; refTable: string; refCols: string[]; onDelete?: "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT" }
export interface Check { name: string; cols: string[]; allowed?: string[] /* parsed col IN (...) = enum */ }
export interface Index { name: string; cols: string[]; unique: boolean; partial: boolean }
export interface Table {
  name: string; // "public.x"
  columns: Column[];
  fks: Fk[];
  checks: Check[];
  uniques: { name: string; cols: string[] }[];
  indexes: Index[];
  rls: boolean;
  policies: string[];
  triggers: string[];
  origin: "baseline" | "stub" | "migration";
  createdIn?: string;
  comment?: string;
}
export interface SchemaModel { tables: Record<string, Table>; views: string[]; functions: string[] }

export type ColSpec = {
  name: string; type: string; nullable?: boolean; default?: string; pk?: boolean; unique?: boolean;
  references?: { table: string; col: string; onDelete?: Fk["onDelete"] };
};
export type SchemaOp =
  | { op: "add_table"; table: string; columns: ColSpec[]; ifNotExists?: boolean }
  | { op: "drop_table"; table: string }
  | { op: "rename_table"; table: string; to: string }
  | { op: "add_column"; table: string; column: ColSpec }
  | { op: "drop_column"; table: string; column: string }
  | { op: "rename_column"; table: string; column: string; to: string }
  | { op: "alter_column"; table: string; column: string; type?: string; nullable?: boolean; default?: string | null }
  | { op: "add_fk"; table: string; name?: string; cols: string[]; refTable: string; refCols: string[]; onDelete?: Fk["onDelete"]; notValid?: boolean }
  | { op: "add_check"; table: string; name?: string; cols: string[]; allowed?: string[] }
  | { op: "add_unique"; table: string; name?: string; cols: string[] }
  | { op: "drop_constraint"; table: string; name: string }
  | { op: "add_index"; table: string; name?: string; cols: string[]; unique?: boolean; partial?: boolean; concurrently?: boolean }
  | { op: "drop_index"; name: string }
  | { op: "rename_index"; name: string; to: string }
  | { op: "rename_constraint"; table: string; name: string; to: string }
  | { op: "set_enum"; table: string; column: string; values: string[] } // LLM-facing sugar → drop+add check
  | { op: "rls"; table: string; on: boolean }
  | { op: "add_policy"; table: string; name: string }
  | { op: "drop_policy"; table: string; name: string }
  | { op: "rename_policy"; table: string; name: string; to: string }
  | { op: "add_trigger"; table: string; name: string }
  | { op: "drop_trigger"; table: string; name: string }
  | { op: "view"; name: string; drop?: boolean }
  | { op: "function"; name: string; drop?: boolean }
  | { op: "data"; table: string; kind: "update" | "insert" | "delete" } // backfills
  | { op: "comment"; table: string; column?: string; text: string }
  | { op: "dynamic"; note: string } // EXECUTE / \gexec: unknowable
  | { op: "guard"; kind: "raise" } // RAISE EXCEPTION safety check
  | { op: "txn"; kind: "begin" | "commit" };

export interface MigrationMeta {
  id: string; // filename
  file: string; // repo-rel
  order: number;
  date: string;
  title: string; // <= 4 words
  magnitude: number;
  worst: RiskLevel | null;
  tables: string[];
  dupPrefix: boolean;
  dynamic: number;
  parseError?: string;
}

export interface ErdCol {
  name: string;
  from?: string;
  type: string; // short: uuid text int bool time date json num text[]
  fullType: string;
  required: boolean;
  pk: boolean;
  fk: boolean;
  unique: boolean;
  indexed: boolean;
  diff: DiffState;
  before?: { type?: string; required?: boolean; default?: string };
  enumValues?: { v: string; diff: DiffState }[];
  comment?: string;
  pinned: boolean; // shown when collapsed: changed | pk | fk
}
export interface ErdTable {
  id: string;
  label: string; // no "public."
  from?: string;
  diff: DiffState;
  origin: Table["origin"];
  rls: boolean;
  badges: Badge[];
  cols: ErdCol[];
  riskIds: string[];
}
export interface ErdEdge { id: string; from: string; fromCol: string; to: string; toCol: string; diff: DiffState; cascade: boolean }
export interface ErdGraph { tables: ErdTable[]; edges: ErdEdge[]; overflow: string[]; risks: Risk[] }
export interface MigrationView {
  meta: MigrationMeta;
  graph: ErdGraph;
  opsSummary: { icon: IconName; text: string /* <=4 words, the part that differs */; diff: DiffState; table?: string /* group header */ }[];
  sql?: string;
}
export interface SchemaHead {
  migrations: MigrationMeta[];
  tables: { id: string; label: string; cols: number; fks: number; origin: Table["origin"]; group: string; lastTouched?: string }[];
  baseline: boolean;
  stats: { files: number; tables: number; parseErrors: number; ms: number };
}
export interface SchemaProposal {
  id: string;
  source: "llm" | "sql" | "git";
  title: string;
  prompt?: string;
  ops: SchemaOp[];
  sql?: string;
  files?: string[];
  baseSig: string;
  createdAt: string;
}
