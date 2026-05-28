/**
 * Shared type definitions for mcp_ctx_tool.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  backgrounded?: boolean;
}

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

export interface RuntimeInfo {
  command: string;
  available: boolean;
  version: string;
  preferred: boolean;
}

export interface RuntimeMap {
  javascript: string;
  typescript: string | null;
  python: string | null;
  shell: string;
  ruby: string | null;
  go: string | null;
  rust: string | null;
  php: string | null;
  perl: string | null;
  r: string | null;
  elixir: string | null;
}
