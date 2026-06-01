/**
 * Context Forge MCP types — unified types used across the server.
 */

export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "shell"
  | "ruby"
  | "go"
  | "rust"
  | "php"
  | "perl"
  | "r"
  | "elixir";

export const SUPPORTED_LANGUAGES: Language[] = [
  "javascript", "typescript", "python", "shell",
  "ruby", "go", "rust", "php", "perl", "r", "elixir",
];

export type ToolGroup = "infra" | "exec" | "index" | "memory";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  backgrounded?: boolean;
}

export interface RuntimeInfo {
  command: string;
  available: boolean;
  version: string;
  preferred: boolean;
}

export type RuntimeMap = Record<Language, string | null>;

export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer?: "porter" | "trigram" | "fuzzy" | "rrf" | "rrf-fuzzy";
}

export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
}

export interface StoreStats {
  totalSources: number;
  totalChunks: number;
  codeChunks: number;
  dbSizeBytes: number;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
