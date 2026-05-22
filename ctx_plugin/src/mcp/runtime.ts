/**
 * Runtime detection for ctx_plugin MCP server.
 *
 * Detects available language runtimes (Node.js, Python, Ruby, etc.)
 * and builds commands to execute code in each language.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Language, RuntimeMap, RuntimeInfo } from "./types.js";

// Re-export types for external use
export type { Language, RuntimeMap, RuntimeInfo } from "./types.js";

const isWindows = process.platform === "win32";

function commandExists(cmd: string): boolean {
  try {
    const check = isWindows ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(check, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function runnableExists(cmd: string): boolean {
  if (isWindows) {
    try {
      const out = execSync(`where ${cmd}`, { encoding: "utf-8", stdio: "pipe" });
      const hits = out.trim().split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
      if (hits.length === 0) return false;
      const realHits = hits.filter((p) => !/\\Microsoft\\WindowsApps\\/i.test(p));
      if (realHits.length === 0) return false;
    } catch {
      return false;
    }
  } else if (!commandExists(cmd)) {
    return false;
  }
  try {
    if (isWindows) {
      execSync(`"${cmd}" --version`, { stdio: "pipe", timeout: 5000 });
    } else {
      execFileSync(cmd, ["--version"], { stdio: "pipe", timeout: 1500 });
    }
    return true;
  } catch {
    return false;
  }
}

function getVersion(cmd: string): string {
  try {
    if (isWindows) {
      const out = execSync(`"${cmd}" --version`, { encoding: "utf-8", stdio: "pipe", timeout: 5000 });
      return out.toString().trim();
    } else {
      const out = execFileSync(cmd, ["--version"], { encoding: "utf-8", stdio: "pipe", timeout: 1500 });
      return out.toString().trim();
    }
  } catch {
    return "unknown";
  }
}

function bunExists(): boolean {
  if (commandExists("bun")) return true;
  for (const p of bunFallbackPaths()) {
    if (existsSync(p)) return true;
  }
  return false;
}

function bunCommand(): string {
  for (const p of bunFallbackPaths()) {
    if (existsSync(p)) return p;
  }
  if (commandExists("bun")) return "bun";
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return isWindows ? `${home}\\.bun\\bin\\bun.exe` : `${home}/.bun/bin/bun`;
}

function bunFallbackPaths(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const appData = process.env.APPDATA ?? "";
  if (isWindows) {
    return [
      ...(home ? [`${home}\\.bun\\bin\\bun.exe`] : []),
      ...(localAppData ? [`${localAppData}\\bun\\bin\\bun.exe`] : []),
      ...(appData ? [`${appData}\\npm\\node_modules\\bun\\bin\\bun.exe`] : []),
    ];
  }
  return [
    ...(home ? [`${home}/.bun/bin/bun`] : []),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
}

function denoCommand(): string {
  for (const p of denoFallbackPaths()) {
    if (existsSync(p)) return p;
  }
  return "deno";
}

function denoExists(): boolean {
  if (commandExists("deno")) return true;
  for (const p of denoFallbackPaths()) {
    if (existsSync(p)) return true;
  }
  return false;
}

function denoFallbackPaths(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    ...(home ? [`${home}/.deno/bin/deno`] : []),
    "/usr/local/bin/deno",
    "/opt/homebrew/bin/deno",
  ];
}

function hasNode(): boolean {
  return runnableExists("node");
}

function nodeCommand(): string {
  if (commandExists("node")) return "node";
  if (commandExists("node.exe")) return "node.exe";
  return "node";
}

function hasNpx(): boolean {
  return runnableExists("npx");
}

function hasPython(): boolean {
  if (runnableExists("python3")) return true;
  if (runnableExists("python")) return true;
  return false;
}

function pythonCommand(): string {
  if (runnableExists("python3")) return "python3";
  if (runnableExists("python")) return "python";
  return "python3";
}

function hasGo(): boolean {
  return runnableExists("go");
}

function hasRust(): boolean {
  return runnableExists("rustc");
}

function hasRuby(): boolean {
  return runnableExists("ruby");
}

function hasPHP(): boolean {
  return runnableExists("php");
}

function hasPerl(): boolean {
  return runnableExists("perl");
}

function hasR(): boolean {
  return runnableExists("R");
}

function hasElixir(): boolean {
  return runnableExists("elixir");
}

function hasBash(): boolean {
  return commandExists("bash");
}

function hasZsh(): boolean {
  return commandExists("zsh");
}

function hasDash(): boolean {
  return commandExists("dash");
}

function hasPwsh(): boolean {
  return runnableExists("pwsh") || runnableExists("powershell");
}

/**
 * Detect all available language runtimes.
 */
export function detectRuntimes(): RuntimeMap {
  return {
    javascript: nodeCommand(),
    typescript: denoExists() ? denoCommand() : (hasNpx() ? "npx" : null),
    python: hasPython() ? pythonCommand() : null,
    shell: detectShell(),
    ruby: hasRuby() ? "ruby" : null,
    go: hasGo() ? "go" : null,
    rust: hasRust() ? "rustc" : null,
    php: hasPHP() ? "php" : null,
    perl: hasPerl() ? "perl" : null,
    r: hasR() ? "R" : null,
    elixir: hasElixir() ? "elixir" : null,
  };
}

function detectShell(): string {
  if (isWindows) {
    if (hasPwsh()) return "pwsh";
    if (commandExists("cmd")) return "cmd";
    return "cmd";
  }
  if (hasZsh()) return "zsh";
  if (hasBash()) return "bash";
  if (hasDash()) return "dash";
  return "sh";
}

/**
 * Get available languages from runtime map.
 */
export function getAvailableLanguages(runtimes: RuntimeMap): Language[] {
  const languages: Language[] = ["javascript", "shell"];
  if (runtimes.typescript) languages.push("typescript");
  if (runtimes.python) languages.push("python");
  if (runtimes.ruby) languages.push("ruby");
  if (runtimes.go) languages.push("go");
  if (runtimes.rust) languages.push("rust");
  if (runtimes.php) languages.push("php");
  if (runtimes.perl) languages.push("perl");
  if (runtimes.r) languages.push("r");
  if (runtimes.elixir) languages.push("elixir");
  return languages;
}

/**
 * Get runtime info for a specific language.
 */
export function getRuntimeInfo(runtimes: RuntimeMap, language: Language): RuntimeInfo {
  const command = runtimes[language];
  return {
    command: command ?? "",
    available: command !== null && command !== undefined,
    version: command ? getVersion(command) : "not found",
    preferred: true,
  };
}

/**
 * Get a summary of all runtimes.
 */
export function getRuntimeSummary(runtimes: RuntimeMap): string {
  const lines: string[] = [];
  for (const [lang, cmd] of Object.entries(runtimes)) {
    if (cmd) {
      lines.push(`  ${lang}: ${cmd} (available)`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "  No runtimes detected";
}

/**
 * Check if bun runtime is available.
 */
export function hasBunRuntime(): boolean {
  return bunExists();
}

/**
 * Build command to execute a script file with the appropriate runtime.
 */
export function buildCommand(runtimes: RuntimeMap, language: Language, filePath: string): string[] {
  switch (language) {
    case "javascript":
      return [runtimes.javascript, filePath];
    case "typescript":
      if (runtimes.typescript === "deno") {
        return [runtimes.typescript, "run", filePath];
      }
      return [runtimes.typescript!, "tsx", filePath];
    case "python":
      return [runtimes.python!, filePath];
    case "shell":
      return [runtimes.shell, filePath];
    case "ruby":
      return [runtimes.ruby!, filePath];
    case "go":
      return ["go", "run", filePath];
    case "rust":
      return ["__rust_compile_run__", filePath];
    case "php":
      return [runtimes.php!, filePath];
    case "perl":
      return [runtimes.perl!, filePath];
    case "r":
      return [runtimes.r!, "CMD", "BATCH", filePath];
    case "elixir":
      return ["elixir", filePath];
    default:
      throw new Error(`Unsupported language: ${language}`);
  }
}
