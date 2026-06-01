/**
 * PolyglotExecutor — sandboxed code execution for multiple languages.
 *
 * Refactored to eliminate the code duplication that existed between
 * `execute()` and `executeFile()` in the original.
 */

import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildCommand, detectRuntimes } from "./runtime.js";
import type { RuntimeMap } from "./runtime.js";
import type { Language, ExecResult } from "../types.js";

const isWin = process.platform === "win32";

const SCRIPT_EXT: Record<Language, string> = {
  javascript: "js", typescript: "ts", python: "py", shell: "sh",
  ruby: "rb", go: "go", rust: "rs", php: "php",
  perl: "pl", r: "R", elixir: "exs",
};

const HARD_CAP = 100 * 1024 * 1024; // 100MB output cap

const OS_TMPDIR = (() => {
  if (isWin) return process.env.TEMP ?? process.env.TMP ?? tmpdir();
  try {
    const result = execFileSync(
      process.platform === "darwin" ? "getconf" : "mktemp",
      process.platform === "darwin" ? ["DARWIN_USER_TEMP_DIR"] : ["-u", "-d"],
      { env: { ...process.env, TMPDIR: undefined as unknown as string }, encoding: "utf-8" }
    ).trim();
    const dir = process.platform === "darwin" ? result : resolve(result, "..");
    if (dir && dir !== process.cwd()) return dir;
  } catch { /* fall through */ }
  return "/tmp";
})();

function killTree(proc: ReturnType<typeof spawn>): void {
  if (isWin && proc.pid) {
    try { execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "pipe" }); } catch { /* already dead */ }
  } else if (proc.pid) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already dead */ }
  }
}

function buildSafeEnv(tmpDir: string, inheritedPath?: string): Record<string, string> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? tmpDir;
  const DENIED = new Set([
    "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS",
    "CDPATH", "INPUTRC", "BASH_XTRACEFD",
    "NODE_OPTIONS", "NODE_PATH",
    "PYTHONSTARTUP", "PYTHONHOME", "PYTHONBREAKPOINT",
    "RUBYOPT", "RUBYLIB",
    "PERL5OPT", "PERL5LIB", "PERLLIB", "PERL5DB",
    "ERL_AFLAGS", "ERL_FLAGS", "ELIXIR_ERL_OPTIONS",
    "GOFLAGS", "CGO_CFLAGS", "CGO_LDFLAGS",
    "RUSTC", "RUSTC_WRAPPER", "RUSTFLAGS",
    "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
    "OPENSSL_CONF", "OPENSSL_ENGINES",
    "CC", "CXX", "AR",
    "GIT_TEMPLATE_DIR", "GIT_CONFIG_GLOBAL", "GIT_EXEC_PATH", "GIT_SSH",
  ]);

  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined && !DENIED.has(key) && !key.startsWith("BASH_FUNC_")) env[key] = val;
  }

  env["TMPDIR"] = tmpDir;
  env["HOME"] = realHome;
  env["LANG"] = "en_US.UTF-8";
  env["PYTHONDONTWRITEBYTECODE"] = "1";
  env["PYTHONUNBUFFERED"] = "1";
  env["PYTHONUTF8"] = "1";
  env["NO_COLOR"] = "1";

  if (inheritedPath) env["PATH"] = inheritedPath;
  else if (!env["PATH"]) env["PATH"] = isWin ? "" : "/usr/local/bin:/usr/bin:/bin";

  if (isWin) {
    env["MSYS_NO_PATHCONV"] = "1";
    env["MSYS2_ARG_CONV_EXCL"] = "*";
    const gitBin = "C:\\Program Files\\Git\\usr\\bin";
    const gitBin2 = "C:\\Program Files\\Git\\bin";
    if (!env["PATH"].includes(gitBin)) env["PATH"] = `${gitBin};${gitBin2};${env["PATH"]}`;
  }

  if (!env["SSL_CERT_FILE"]) {
    for (const p of ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"]) {
      if (existsSync(p)) { env["SSL_CERT_FILE"] = p; break; }
    }
  }

  return env;
}

async function compileAndRunRust(srcPath: string, cwd: string, timeout?: number, safeEnv?: Record<string, string>): Promise<ExecResult> {
  const binSuffix = isWin ? ".exe" : "";
  const binPath = srcPath.replace(/\.rs$/, "") + binSuffix;
  try {
    execFileSync("rustc", [srcPath, "-o", binPath], {
      cwd, timeout: timeout === undefined ? 60_000 : Math.min(timeout, 60_000),
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    return { stdout: "", stderr: `Compilation failed:\n${message}`, exitCode: 1, timedOut: false };
  }
  // Now run the binary
  return spawnCmd([binPath], cwd, cwd, safeEnv ?? {}, timeout);
}

async function spawnCmd(
  cmd: string[],
  cwd: string,
  sandboxTmpDir: string,
  safeEnv: Record<string, string>,
  timeout?: number,
): Promise<ExecResult> {
  return new Promise((res) => {
    const needsShell = isWin && ["tsx", "ts-node", "elixir"].includes(cmd[0]);
    let spawnCmd = cmd[0];
    let spawnArgs = isWin && cmd.length === 2 && cmd[1]
      ? [cmd[1].replace(/\\/g, "/")]
      : (isWin ? cmd.slice(1).map((a) => a.replace(/\\/g, "/")) : cmd.slice(1));

    const proc = needsShell
      ? spawn([spawnCmd, ...spawnArgs].join(" "), [], {
          cwd, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
          env: safeEnv, detached: !isWin, windowsHide: isWin, shell: true,
        })
      : spawn(spawnCmd, spawnArgs, {
          cwd, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
          env: safeEnv, detached: !isWin, windowsHide: isWin, shell: false,
        });

    let timedOut = false;
    let resolved = false;
    const timer: NodeJS.Timeout | undefined = timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, timeout);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;

    proc.stdout!.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= HARD_CAP) stdoutChunks.push(chunk);
      else killTree(proc);
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= HARD_CAP) stderrChunks.push(chunk);
      else killTree(proc);
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      if (resolved) return;
      res({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: timedOut ? 1 : (exitCode ?? 1),
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (resolved) return;
      res({ stdout: "", stderr: err.message, exitCode: 1, timedOut: false });
    });
  });
}

export class PolyglotExecutor {
  #hardCapBytes: number;
  #projectRootResolver: () => string;
  #runtimes: RuntimeMap;

  constructor(opts?: {
    hardCapBytes?: number;
    projectRoot?: string | (() => string);
    runtimes?: RuntimeMap;
  }) {
    this.#hardCapBytes = opts?.hardCapBytes ?? HARD_CAP;
    const pr = opts?.projectRoot;
    if (typeof pr === "function") this.#projectRootResolver = pr;
    else if (typeof pr === "string") this.#projectRootResolver = () => pr;
    else this.#projectRootResolver = () => process.cwd();
    this.#runtimes = opts?.runtimes ?? detectRuntimes();
  }

  get #projectRoot(): string { return this.#projectRootResolver(); }
  get runtimes(): RuntimeMap { return { ...this.#runtimes }; }

  cleanupBackgrounded(): void {
    // no-op in this simplified version
  }

  async execute(opts: {
    language: Language;
    code: string;
    timeout?: number;
    background?: boolean;
  }): Promise<ExecResult> {
    const { language, code, timeout } = opts;
    const tmpDir = mkdtempSync(join(OS_TMPDIR, ".mcp-exec-"));

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const cmd = buildCommand(this.#runtimes, language, filePath);
      const cwd = language === "shell" ? this.#projectRoot : tmpDir;
      const safeEnv = buildSafeEnv(tmpDir, process.env.PATH);

      if (cmd[0] === "__rust_compile_run__") {
        const result = await compileAndRunRust(filePath, tmpDir, timeout, safeEnv);
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return result;
      }

      const result = await spawnCmd(cmd, cwd, tmpDir, safeEnv, timeout);
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return result;
    } catch (err) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw err;
    }
  }

  #writeScript(tmpDir: string, code: string, language: Language): string {
    if (language === "go" && !code.includes("package ")) {
      code = `package main\n\nimport "fmt"\n\nfunc main() {\n${code}\n}\n`;
    }
    if (language === "php" && !code.trimStart().startsWith("<?")) {
      code = `<?php\n${code}`;
    }
    const fp = join(tmpDir, `script.${SCRIPT_EXT[language]}`);
    if (language === "shell") {
      const inheritedPath = process.env.PATH;
      const content = inheritedPath
        ? `export PATH=${`'${inheritedPath.replace(/'/g, `'\\''`)}`}\n${code}`
        : code;
      writeFileSync(fp, content, { encoding: "utf-8", mode: 0o700 });
    } else {
      writeFileSync(fp, code, "utf-8");
    }
    return fp;
  }

  async executeFile(opts: {
    path: string;
    args?: string[];
    env?: Record<string, string>;
    timeout?: number;
  }): Promise<ExecResult> {
    const { path: filePath, args = [], env = {}, timeout } = opts;

    const resolvedPath = resolve(
      filePath.startsWith("/") || (isWin && /^[A-Z]:\\/i.test(filePath)) ? filePath
        : resolve(this.#projectRoot, filePath)
    );
    if (resolvedPath.includes("..")) {
      return { stdout: "", stderr: `Path traversal blocked: "${filePath}" contains parent directory references`, exitCode: 1, timedOut: false };
    }
    const normalizedRoot = resolve(this.#projectRoot);
    if (!resolvedPath.startsWith(normalizedRoot + (isWin ? "\\" : "/")) && resolvedPath !== normalizedRoot) {
      return { stdout: "", stderr: `Path traversal blocked: "${filePath}" resolves outside project root`, exitCode: 1, timedOut: false };
    }
    if (!existsSync(resolvedPath)) {
      return { stdout: "", stderr: `File not found: ${filePath}`, exitCode: 1, timedOut: false };
    }

    const rawContent = readFileSync(resolvedPath, { encoding: "utf-8" });
    const shebang = rawContent.split("\n")[0];
    let language: Language = "shell";

    if (shebang.startsWith("#!")) {
      if (/python/.test(shebang)) language = "python";
      else if (/node|nodejs/.test(shebang)) language = "javascript";
      else if (/deno/.test(shebang)) language = "typescript";
      else if (/ruby/.test(shebang)) language = "ruby";
      else if (/bash|sh\b/.test(shebang)) language = "shell";
      else if (/php/.test(shebang)) language = "php";
      else if (/perl/.test(shebang)) language = "perl";
      else if (/r\b|Rscript/.test(shebang)) language = "r";
    }

    if (language === "shell") {
      const ext = resolvedPath.split(".").pop()?.toLowerCase();
      const extMap: Record<string, Language> = {
        js: "javascript", mjs: "javascript", ts: "typescript", py: "python",
        rb: "ruby", go: "go", rs: "rust", php: "php", pl: "perl",
        R: "r", r: "r", exs: "elixir", sh: "shell", bash: "shell",
      };
      if (ext && extMap[ext]) language = extMap[ext];
    }

    const cmd = buildCommand(this.#runtimes, language, resolvedPath);
    if (cmd[0] !== "__rust_compile_run__" && args.length > 0) cmd.push(...args);

    const tmpDir = mkdtempSync(join(OS_TMPDIR, ".mcp-exec-file-"));
    const safeEnv = { ...buildSafeEnv(tmpDir, process.env.PATH), ...env };

    try {
      if (cmd[0] === "__rust_compile_run__") {
        const result = await compileAndRunRust(resolvedPath, tmpDir, timeout, safeEnv);
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return result;
      }

      const cwd = language === "shell" ? this.#projectRoot : tmpDir;
      const result = await spawnCmd(cmd, cwd, tmpDir, safeEnv, timeout);
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return result;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async batchExecute(opts: {
    commands: Array<{ language: Language; code: string }>;
    sequential?: boolean;
    stopOnError?: boolean;
  }): Promise<{ results: ExecResult[]; totalTime: number }> {
    const { commands, sequential = false, stopOnError = false } = opts;
    const results: ExecResult[] = [];
    const startTime = Date.now();

    if (sequential) {
      for (const cmd of commands) {
        const result = await this.execute({ language: cmd.language, code: cmd.code, timeout: 30000 });
        results.push(result);
        if (stopOnError && result.exitCode !== 0) break;
      }
    } else {
      results.push(...(await Promise.all(
        commands.map((cmd) => this.execute({ language: cmd.language, code: cmd.code, timeout: 30000 }))
      )));
    }

    return { results, totalTime: Date.now() - startTime };
  }
}
