/**
 * PolyglotExecutor - Sandbox code execution for mcp_ctx_tool.
 *
 * Executes code in various languages with process isolation,
 * environment sanitization, and output buffering.
 */

import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRuntimes,
  buildCommand,
  type RuntimeMap,
  type Language,
} from "./runtime.js";
import type { ExecResult } from "./types.js";

const isWin = process.platform === "win32";

const SCRIPT_EXT: Record<Language, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  shell: "sh",
  ruby: "rb",
  go: "go",
  rust: "rs",
  php: "php",
  perl: "pl",
  r: "R",
  elixir: "exs",
};

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
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "pipe" });
    } catch { /* already dead */ }
  } else if (proc.pid) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch { /* already dead */ }
  }
}

interface ExecuteOptions {
  language: Language;
  code: string;
  timeout?: number;
  background?: boolean;
}

export class PolyglotExecutor {
  #hardCapBytes: number;
  #projectRootResolver: () => string;
  #runtimes: RuntimeMap;
  #backgroundedPids = new Set<number>();

  constructor(opts?: {
    hardCapBytes?: number;
    projectRoot?: string | (() => string);
    runtimes?: RuntimeMap;
  }) {
    this.#hardCapBytes = opts?.hardCapBytes ?? 100 * 1024 * 1024;
    const pr = opts?.projectRoot;
    if (typeof pr === "function") {
      this.#projectRootResolver = pr;
    } else if (typeof pr === "string") {
      this.#projectRootResolver = () => pr;
    } else {
      this.#projectRootResolver = () => process.cwd();
    }
    this.#runtimes = opts?.runtimes ?? detectRuntimes();
  }

  get #projectRoot(): string {
    return this.#projectRootResolver();
  }

  get runtimes(): RuntimeMap {
    return { ...this.#runtimes };
  }

  cleanupBackgrounded(): void {
    for (const pid of this.#backgroundedPids) {
      try {
        process.kill(isWin ? pid : -pid, "SIGTERM");
      } catch { /* already dead */ }
    }
    this.#backgroundedPids.clear();
  }

  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout, background = false } = opts;
    const tmpDir = mkdtempSync(join(OS_TMPDIR, ".mcp-ctx-tool-"));

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const cmd = buildCommand(this.#runtimes, language, filePath);

      if (cmd[0] === "__rust_compile_run__") {
        return await this.#compileAndRun(filePath, tmpDir, timeout);
      }

      const cwd = language === "shell" ? this.#projectRoot : tmpDir;
      const result = await this.#spawn(cmd, cwd, tmpDir, timeout, background);

      if (!result.backgrounded) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
      }

      return result;
    } catch (err) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
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

    if (language === "elixir" && existsSync(join(this.#projectRoot, "mix.exs"))) {
      const escaped = JSON.stringify(join(this.#projectRoot, "_build/dev/lib"));
      code = `Path.wildcard(Path.join(${escaped}, "*/ebin"))\n|> Enum.each(&Code.prepend_path/1)\n\n${code}`;
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

  async #compileAndRun(
    srcPath: string,
    cwd: string,
    timeout: number | undefined
  ): Promise<ExecResult> {
    const binSuffix = isWin ? ".exe" : "";
    const binPath = srcPath.replace(/\.rs$/, "") + binSuffix;

    try {
      execFileSync("rustc", [srcPath, "-o", binPath], {
        cwd,
        timeout: timeout === undefined ? 60_000 : Math.min(timeout, 60_000),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
      return {
        stdout: "",
        stderr: `Compilation failed:\n${message}`,
        exitCode: 1,
        timedOut: false,
      };
    }

    return this.#spawn([binPath], cwd, cwd, timeout);
  }

  async #spawn(
    cmd: string[],
    cwd: string,
    sandboxTmpDir: string,
    timeout: number | undefined,
    background = false
  ): Promise<ExecResult> {
    return new Promise((res) => {
      const needsShell = isWin && ["tsx", "ts-node", "elixir"].includes(cmd[0]);

      let spawnCmd = cmd[0];
      let spawnArgs: string[];
      if (isWin && cmd.length === 2 && cmd[1]) {
        const posixPath = cmd[1].replace(/\\/g, "/");
        spawnArgs = [posixPath];
      } else {
        spawnArgs = isWin ? cmd.slice(1).map((a) => a.replace(/\\/g, "/")) : cmd.slice(1);
      }

      const commonOpts = {
        cwd,
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
        env: this.#buildSafeEnv(sandboxTmpDir),
        detached: !isWin,
        windowsHide: isWin,
      };

      let proc: ReturnType<typeof spawn>;
      if (needsShell) {
        const fullCmd = [spawnCmd, ...spawnArgs].map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(" ");
        proc = spawn(fullCmd, [], { ...commonOpts, shell: true });
      } else {
        proc = spawn(spawnCmd, spawnArgs, { ...commonOpts, shell: false });
      }

      let timedOut = false;
      let resolved = false;
      let timerFiring = false;
      const timer: NodeJS.Timeout | undefined = timeout === undefined ? undefined : setTimeout(() => {
        timerFiring = true;
        timedOut = true;
        if (background) {
          resolved = true;
          if (proc.pid) this.#backgroundedPids.add(proc.pid);
          proc.unref();
          proc.stdout!.destroy();
          proc.stderr!.destroy();
          const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
          const rawStderr = Buffer.concat(stderrChunks).toString("utf-8");
          res({ stdout: rawStdout, stderr: rawStderr, exitCode: 0, timedOut: true, backgrounded: true });
        } else {
          killTree(proc);
        }
      }, timeout);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let capExceeded = false;

      proc.stdout!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.#hardCapBytes) {
          stdoutChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.#hardCapBytes) {
          stderrChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        if (resolved) return;
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (capExceeded) {
          rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB - process killed]`;
        }

        res({
          stdout: rawStdout,
          stderr: rawStderr,
          exitCode: timedOut ? 1 : (exitCode ?? 1),
          timedOut,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (resolved) return;
        res({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
        });
      });
    });
  }

  #buildSafeEnv(tmpDir: string): Record<string, string> {
    const realHome = process.env.HOME ?? process.env.USERPROFILE ?? tmpDir;

    const DENIED = new Set([
      "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS",
      "CDPATH", "INPUTRC", "BASH_XTRACEFD",
      "NODE_OPTIONS", "NODE_PATH",
      "PYTHONSTARTUP", "PYTHONHOME", "PYTHONBREAKPOINT", "PYTHONINSPECT",
      "RUBYOPT", "RUBYLIB",
      "PERL5OPT", "PERL5LIB", "PERLLIB", "PERL5DB",
      "ERL_AFLAGS", "ERL_FLAGS", "ELIXIR_ERL_OPTIONS", "ERL_LIBS",
      "GOFLAGS", "CGO_CFLAGS", "CGO_LDFLAGS",
      "RUSTC", "RUSTC_WRAPPER", "RUSTFLAGS",
      "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
      "OPENSSL_CONF", "OPENSSL_ENGINES",
      "CC", "CXX", "AR",
      "GIT_TEMPLATE_DIR", "GIT_CONFIG_GLOBAL", "GIT_EXEC_PATH", "GIT_SSH",
    ]);

    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val !== undefined && !DENIED.has(key) && !key.startsWith("BASH_FUNC_")) {
        env[key] = val;
      }
    }

    env["TMPDIR"] = tmpDir;
    env["HOME"] = realHome;
    env["LANG"] = "en_US.UTF-8";
    env["PYTHONDONTWRITEBYTECODE"] = "1";
    env["PYTHONUNBUFFERED"] = "1";
    env["PYTHONUTF8"] = "1";
    env["NO_COLOR"] = "1";

    if (isWin && !env["PATH"] && env["Path"]) {
      env["PATH"] = env["Path"];
      delete env["Path"];
    }
    if (!env["PATH"]) {
      env["PATH"] = isWin ? "" : "/usr/local/bin:/usr/bin:/bin";
    }

    if (isWin) {
      env["MSYS_NO_PATHCONV"] = "1";
      env["MSYS2_ARG_CONV_EXCL"] = "*";
      const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
      const gitBin = "C:\\Program Files\\Git\\bin";
      if (!env["PATH"].includes(gitUsrBin)) {
        env["PATH"] = `${gitUsrBin};${gitBin};${env["PATH"]}`;
      }
    }

    if (!env["SSL_CERT_FILE"]) {
      const certPaths = isWin ? [] : [
        "/etc/ssl/cert.pem",
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
      ];
      for (const p of certPaths) {
        if (existsSync(p)) {
          env["SSL_CERT_FILE"] = p;
          break;
        }
      }
    }

    return env;
  }

  async executeFile(opts: {
    path: string;
    args?: string[];
    env?: Record<string, string>;
    timeout?: number;
  }): Promise<ExecResult> {
    const { path: filePath, args = [], env = {}, timeout } = opts;

    if (!existsSync(filePath)) {
      return {
        stdout: "",
        stderr: `File not found: ${filePath}`,
        exitCode: 1,
        timedOut: false,
      };
    }

    const rawContent = readFileSync(filePath, { encoding: "utf-8", flag: "r" });
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
      const ext = filePath.split(".").pop()?.toLowerCase();
      const extMap: Record<string, Language> = {
        js: "javascript", mjs: "javascript", cjs: "javascript",
        ts: "typescript", mts: "typescript",
        py: "python",
        rb: "ruby",
        go: "go",
        rs: "rust",
        php: "php",
        pl: "perl",
        R: "r", r: "r",
        exs: "elixir",
        sh: "shell", bash: "shell",
      };
      if (ext && extMap[ext]) language = extMap[ext];
    }

    const cmd = buildCommand(this.#runtimes, language, filePath);
    if (cmd[0] !== "__rust_compile_run__" && args.length > 0) {
      cmd.push(...args);
    }

    const tmpDir = mkdtempSync(join(OS_TMPDIR, ".mcp-ctx-tool-file-"));
    const mergedEnv = { ...this.#buildSafeEnv(tmpDir), ...env };

    try {
      if (cmd[0] === "__rust_compile_run__") {
        return await this.#compileAndRun(filePath, tmpDir, timeout);
      }

      const cwd = language === "shell" ? this.#projectRoot : tmpDir;
      return new Promise((res) => {
        const needsShell = isWin && ["tsx", "ts-node", "elixir"].includes(cmd[0]);
        let spawnCmd = cmd[0];
        let spawnArgs = isWin ? cmd.slice(1).map((a) => a.replace(/\\/g, "/")) : cmd.slice(1);

        const proc = needsShell
          ? spawn([spawnCmd, ...spawnArgs].join(" "), [], {
            cwd, stdio: ["ignore", "pipe", "pipe"], env: mergedEnv,
            detached: !isWin, windowsHide: isWin, shell: true,
          })
          : spawn(spawnCmd, spawnArgs, {
            cwd, stdio: ["ignore", "pipe", "pipe"], env: mergedEnv,
            detached: !isWin, windowsHide: isWin, shell: false,
          });

        let timedOut = false;
        let resolved = false;
        let capExceeded = false;
        const timer = timeout === undefined ? undefined : setTimeout(() => {
          timedOut = true;
          resolved = true;
          killTree(proc);
        }, timeout);

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let totalBytes = 0;

        proc.stdout!.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes <= this.#hardCapBytes) {
            stdoutChunks.push(chunk);
          } else if (!capExceeded) {
            capExceeded = true;
            killTree(proc);
          }
        });
        proc.stderr!.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes <= this.#hardCapBytes) {
            stderrChunks.push(chunk);
          } else if (!capExceeded) {
            capExceeded = true;
            killTree(proc);
          }
        });

        proc.on("close", (exitCode) => {
          clearTimeout(timer);
          if (resolved) return;
          let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");
          if (capExceeded) {
            rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB - process killed]`;
          }
          res({
            stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
            stderr: rawStderr,
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
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async batchExecute(opts: {
    commands: Array<{ language: Language; code: string }>;
    sequential?: boolean;
    stopOnError?: boolean;
  }): Promise<{
    results: ExecResult[];
    totalTime: number;
  }> {
    const { commands, sequential = false, stopOnError = false } = opts;
    const results: ExecResult[] = [];
    const startTime = Date.now();

    if (sequential) {
      for (const cmd of commands) {
        const result = await this.execute({
          language: cmd.language,
          code: cmd.code,
          timeout: 30000,
        });
        results.push(result);
        if (stopOnError && result.exitCode !== 0) break;
      }
    } else {
      const promises = commands.map((cmd) =>
        this.execute({ language: cmd.language, code: cmd.code, timeout: 30000 }),
      );
      results.push(...(await Promise.all(promises)));
    }

    return { results, totalTime: Date.now() - startTime };
  }
}
