/**
 * Runtime detection — detects available language runtimes and builds commands.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Language, RuntimeMap } from "../types.js";

export type { Language, RuntimeMap };

const isWindows = process.platform === "win32";

function commandExists(cmd: string): boolean {
  try {
    execSync(isWindows ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "pipe" });
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
      return hits.some((p) => !/\\Microsoft\\WindowsApps\\/i.test(p));
    } catch {
      return false;
    }
  }
  return commandExists(cmd);
}

function getVersion(cmd: string): string {
  try {
    const out = execFileSync(cmd, ["--version"], { encoding: "utf-8", timeout: 1500 });
    return out.toString().trim();
  } catch {
    return "unknown";
  }
}

function bunCommand(): string {
  for (const p of bunFallbackPaths()) {
    if (existsSync(p)) return p;
  }
  return commandExists("bun") ? "bun" : (isWindows ? `${process.env.HOME}\\..bun\\bin\\bun.exe` : `${process.env.HOME}/.bun/bin/bun`);
}

function bunFallbackPaths(): string[] {
  const home = process.env.HOME ?? "";
  return [
    `${home}/.bun/bin/bun`,
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

function denoFallbackPaths(): string[] {
  const home = process.env.HOME ?? "";
  return [
    `${home}/.deno/bin/deno`,
    "/usr/local/bin/deno",
    "/opt/homebrew/bin/deno",
  ];
}

function pythonCommand(): string {
  return runnableExists("python3") ? "python3" : (runnableExists("python") ? "python" : "python3");
}

export function detectRuntimes(): RuntimeMap {
  return {
    javascript: commandExists("node") ? "node" : "",
    typescript: runnableExists("deno") ? denoCommand() : (runnableExists("npx") ? "npx" : null),
    python: runnableExists("python3") || runnableExists("python") ? pythonCommand() : null,
    shell: detectShell(),
    ruby: runnableExists("ruby") ? "ruby" : null,
    go: runnableExists("go") ? "go" : null,
    rust: runnableExists("rustc") ? "rustc" : null,
    php: runnableExists("php") ? "php" : null,
    perl: runnableExists("perl") ? "perl" : null,
    r: runnableExists("R") ? "R" : null,
    elixir: runnableExists("elixir") ? "elixir" : null,
  };
}

function detectShell(): string {
  if (isWindows) {
    return runnableExists("pwsh") ? "pwsh" : (commandExists("cmd") ? "cmd" : "cmd");
  }
  if (commandExists("zsh")) return "zsh";
  if (commandExists("bash")) return "bash";
  if (commandExists("dash")) return "dash";
  return "sh";
}

export function buildCommand(runtimes: RuntimeMap, language: Language, filePath: string): string[] {
  switch (language) {
    case "javascript": return [runtimes.javascript || "node", filePath];
    case "typescript":
      if (runtimes.typescript === "deno") return [runtimes.typescript, "run", filePath];
      return [runtimes.typescript ?? "npx", "tsx", filePath];
    case "python": return [runtimes.python!, filePath];
    case "shell": return [runtimes.shell || "sh", filePath];
    case "ruby": return [runtimes.ruby!, filePath];
    case "go": return ["go", "run", filePath];
    case "rust": return ["__rust_compile_run__", filePath];
    case "php": return [runtimes.php!, filePath];
    case "perl": return [runtimes.perl!, filePath];
    case "r": return [runtimes.r!, "CMD", "BATCH", filePath];
    case "elixir": return ["elixir", filePath];
    default: throw new Error(`Unsupported language: ${language}`);
  }
}

export function getRuntimeVersion(cmd: string): string {
  if (!cmd) return "not found";
  return getVersion(cmd);
}
