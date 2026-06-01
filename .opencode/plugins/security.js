/**
 * security.ts — Security policy engine for ctx_plugin
 *
 * Ported from context-mode's src/security.ts, trimmed for opencode plugin usage.
 * Handles:
 *   - Glob-to-regex pattern matching (Bash commands, file paths)
 *   - Chained command splitting (&&, ||, ;, |)
 *   - Shell-escape detection in non-shell code (Python, JS, Ruby, etc.)
 *   - Config file loading from opencode settings
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
// ─────────────────────────────────────────────────────────
// Glob Pattern Parsing
// ─────────────────────────────────────────────────────────
/** Extract glob from "Bash(glob)" pattern. Returns null for non-Bash patterns. */
export function parseBashPattern(pattern) {
    const match = pattern.match(/^Bash\((.+)\)$/);
    return match ? match[1] : null;
}
/** Parse "ToolName(glob)" into { tool, glob }. */
export function parseToolPattern(pattern) {
    const match = pattern.match(/^(\w+)\((.+)\)$/);
    return match ? { tool: match[1], glob: match[2] } : null;
}
// ─────────────────────────────────────────────────────────
// Glob-to-Regex Conversion
// ─────────────────────────────────────────────────────────
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}
function convertGlobPart(glob) {
    return glob
        .replace(/[.+?^${}()|[\]\\\/]/g, "\\$&")
        .replace(/\*/g, ".*");
}
/**
 * Convert a Bash permission glob to a regex.
 * Colon format: "command:argsGlob" → /^command(\s.*)?$/
 * Space format: "sudo *" → /^sudo .*$/
 */
export function globToRegex(glob, caseInsensitive = false) {
    const colonIdx = glob.indexOf(":");
    if (colonIdx !== -1) {
        const command = glob.slice(0, colonIdx);
        const argsGlob = glob.slice(colonIdx + 1);
        const regexStr = `^${escapeRegex(command)}(\\s${convertGlobPart(argsGlob)})?$`;
        return new RegExp(regexStr, caseInsensitive ? "i" : "");
    }
    return new RegExp(`^${convertGlobPart(glob)}$`, caseInsensitive ? "i" : "");
}
/**
 * Convert a file path glob to a regex.
 * - `**` matches any number of path segments
 * - `*` matches anything except /
 * - Paths are normalized to forward slashes
 */
export function fileGlobToRegex(glob, caseInsensitive = false) {
    let regexStr = "";
    let i = 0;
    while (i < glob.length) {
        if (glob[i] === "*" && glob[i + 1] === "*") {
            if (i + 2 < glob.length && glob[i + 2] === "/") {
                regexStr += "(.*/)?";
                i += 3;
            }
            else {
                regexStr += ".*";
                i += 2;
            }
        }
        else if (glob[i] === "*") {
            regexStr += "[^/]*";
            i++;
        }
        else if (glob[i] === "?") {
            regexStr += "[^/]";
            i++;
        }
        else {
            regexStr += glob[i].replace(/[.+^${}()|[\]\\\/]/g, "\\$&");
            i++;
        }
    }
    return new RegExp(`^${regexStr}$`, caseInsensitive ? "i" : "");
}
/** Test a command against a list of glob patterns. Returns matched pattern or null. */
export function matchesAnyPattern(command, patterns, caseInsensitive = false) {
    for (const pattern of patterns) {
        const glob = parseBashPattern(pattern);
        if (!glob)
            continue;
        if (globToRegex(glob, caseInsensitive).test(command))
            return pattern;
    }
    return null;
}
// ─────────────────────────────────────────────────────────
// Chained Command Splitting
// ─────────────────────────────────────────────────────────
/**
 * Split a shell command on chain operators (&&, ||, ;, |) while
 * respecting single/double quotes and backticks.
 * Prevents bypassing deny patterns by prepending innocent commands.
 */
export function splitChainedCommands(command) {
    const parts = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        const prev = i > 0 ? command[i - 1] : "";
        if (ch === "'" && !inDouble && !inBacktick && prev !== "\\") {
            inSingle = !inSingle;
            current += ch;
        }
        else if (ch === '"' && !inSingle && !inBacktick && prev !== "\\") {
            inDouble = !inDouble;
            current += ch;
        }
        else if (ch === "`" && !inSingle && !inDouble && prev !== "\\") {
            inBacktick = !inBacktick;
            current += ch;
        }
        else if (!inSingle && !inDouble && !inBacktick) {
            if (ch === ";") {
                parts.push(current.trim());
                current = "";
            }
            else if (ch === "|" && command[i + 1] === "|") {
                parts.push(current.trim());
                current = "";
                i++;
            }
            else if (ch === "&" && command[i + 1] === "&") {
                parts.push(current.trim());
                current = "";
                i++;
            }
            else if (ch === "|") {
                parts.push(current.trim());
                current = "";
            }
            else {
                current += ch;
            }
        }
        else {
            current += ch;
        }
    }
    if (current.trim())
        parts.push(current.trim());
    return parts.filter((p) => p.length > 0);
}
// ─────────────────────────────────────────────────────────
// Config File Reading
// ─────────────────────────────────────────────────────────
function getOpencodeConfigDir() {
    if (process.env.OPENCODE_CONFIG_DIR)
        return process.env.OPENCODE_CONFIG_DIR;
    if (process.env.XDG_CONFIG_HOME)
        return resolve(process.env.XDG_CONFIG_HOME, "opencode");
    if (process.platform === "win32") {
        return resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "opencode");
    }
    return resolve(homedir(), ".config", "opencode");
}
function readSingleSettings(path) {
    try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw);
        const perms = parsed?.permissions;
        if (!perms || typeof perms !== "object")
            return null;
        const filterBash = (arr) => {
            if (!Array.isArray(arr))
                return [];
            return arr.filter((p) => typeof p === "string" && parseBashPattern(p) !== null);
        };
        return {
            allow: filterBash(perms.allow),
            deny: filterBash(perms.deny),
            ask: filterBash(perms.ask),
        };
    }
    catch {
        return null;
    }
}
/**
 * Read Bash permission policies from opencode settings.
 * Precedence: project-local > global config
 */
export function readBashPolicies(projectDir) {
    const policies = [];
    const configDir = getOpencodeConfigDir();
    if (projectDir) {
        const local = readSingleSettings(resolve(projectDir, ".opencode", "settings.json"));
        if (local)
            policies.push(local);
    }
    const global = readSingleSettings(resolve(configDir, "settings.json"));
    if (global)
        policies.push(global);
    return policies;
}
// ─────────────────────────────────────────────────────────
// Decision Engine
// ─────────────────────────────────────────────────────────
/**
 * Evaluate a bash command against security policies.
 * - deny > ask > allow (most restrictive wins)
 * - Checks each chained segment against deny patterns
 * - Default: "ask"
 */
export function evaluateCommand(command, policies, caseInsensitive = process.platform === "win32") {
    const segments = splitChainedCommands(command);
    for (const segment of segments) {
        for (const policy of policies) {
            const denyMatch = matchesAnyPattern(segment, policy.deny, caseInsensitive);
            if (denyMatch)
                return { decision: "deny", matchedPattern: denyMatch };
        }
    }
    for (const policy of policies) {
        const askMatch = matchesAnyPattern(command, policy.ask, caseInsensitive);
        if (askMatch)
            return { decision: "ask", matchedPattern: askMatch };
        const allowMatch = matchesAnyPattern(command, policy.allow, caseInsensitive);
        if (allowMatch)
            return { decision: "allow", matchedPattern: allowMatch };
    }
    return { decision: "ask" };
}
/**
 * Server-side variant: only enforce deny patterns (no "ask" UI).
 */
export function evaluateCommandDenyOnly(command, policies, caseInsensitive = process.platform === "win32") {
    const segments = splitChainedCommands(command);
    for (const segment of segments) {
        for (const policy of policies) {
            const denyMatch = matchesAnyPattern(segment, policy.deny, caseInsensitive);
            if (denyMatch)
                return { decision: "deny", matchedPattern: denyMatch };
        }
    }
    return { decision: "allow" };
}
// ─────────────────────────────────────────────────────────
// File Path Evaluation
// ─────────────────────────────────────────────────────────
/** Check if a file path matches any deny glob. */
export function evaluateFilePath(filePath, denyGlobs, caseInsensitive = process.platform === "win32") {
    const toForward = (path) => path.replace(/\\/g, "/");
    const candidates = new Set();
    candidates.add(toForward(filePath));
    for (const globs of denyGlobs) {
        for (const glob of globs) {
            const regex = fileGlobToRegex(toForward(glob), caseInsensitive);
            for (const candidate of candidates) {
                if (regex.test(candidate)) {
                    return { denied: true, matchedPattern: glob };
                }
            }
        }
    }
    return { denied: false };
}
// ─────────────────────────────────────────────────────────
// Shell-Escape Scanner
// ─────────────────────────────────────────────────────────
const SHELL_ESCAPE_PATTERNS = {
    python: [
        /os\.system\(\s*(['"])(.*?)\1\s*\)/g,
        /subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*(['"])(.*?)\1/g,
    ],
    javascript: [
        /exec(?:Sync|File|FileSync)?\(\s*(['"`])(.*?)\1/g,
        /spawn(?:Sync)?\(\s*(['"`])(.*?)\1/g,
    ],
    typescript: [
        /exec(?:Sync|File|FileSync)?\(\s*(['"`])(.*?)\1/g,
        /spawn(?:Sync)?\(\s*(['"`])(.*?)\1/g,
    ],
    ruby: [
        /system\(\s*(['"])(.*?)\1/g,
        /`(.*?)`/g,
    ],
    go: [
        /exec\.Command\(\s*(['"`])(.*?)\1/g,
    ],
    php: [
        /shell_exec\(\s*(['"`])(.*?)\1/g,
        /(?:^|[^.])exec\(\s*(['"`])(.*?)\1/g,
        /(?:^|[^.])system\(\s*(['"`])(.*?)\1/g,
        /passthru\(\s*(['"`])(.*?)\1/g,
        /proc_open\(\s*(['"`])(.*?)\1/g,
    ],
    rust: [
        /Command::new\(\s*(['"`])(.*?)\1/g,
    ],
};
function extractPythonSubprocessListArgs(code) {
    const commands = [];
    const pattern = /subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*\[([^\]]+)\]/g;
    let match;
    while ((match = pattern.exec(code)) !== null) {
        const listContent = match[1];
        const args = [...listContent.matchAll(/(['"])(.*?)\1/g)].map((m) => m[2]);
        if (args.length > 0)
            commands.push(args.join(" "));
    }
    return commands;
}
/**
 * Scan non-shell code for shell-escape calls.
 * Returns array of embedded command strings.
 */
export function extractShellCommands(code, language) {
    const patterns = SHELL_ESCAPE_PATTERNS[language];
    if (!patterns && language !== "python")
        return [];
    const commands = [];
    if (patterns) {
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(code)) !== null) {
                const command = match[match.length - 1];
                if (command)
                    commands.push(command);
            }
        }
    }
    if (language === "python") {
        commands.push(...extractPythonSubprocessListArgs(code));
    }
    return commands;
}
// ─────────────────────────────────────────────────────────
// High-Level Security Check
// ─────────────────────────────────────────────────────────
/**
 * Check a tool call against security policies.
 * Returns a SecurityResult with the appropriate action.
 */
export function checkSecurityPolicy(args) {
    const policies = args.policies ?? readBashPolicies();
    const tool = args.tool.toLowerCase();
    if (tool === "bash" || tool === "shell") {
        if (!args.command)
            return { action: "allow" };
        // Check deny-only (no ask prompt in plugin context)
        const result = evaluateCommandDenyOnly(args.command, policies);
        if (result.decision === "deny") {
            return {
                action: "deny",
                reason: `Blocked by security policy: "${result.matchedPattern}"`,
                matchedPattern: result.matchedPattern,
            };
        }
        // Extract shell escapes from code executed via shell language
        if (args.language === "shell" && args.code) {
            const shellCommands = extractShellCommands(args.code, "bash");
            for (const cmd of shellCommands) {
                const escResult = evaluateCommandDenyOnly(cmd, policies);
                if (escResult.decision === "deny") {
                    return {
                        action: "deny",
                        reason: `Blocked shell escape: "${escResult.matchedPattern}"`,
                        matchedPattern: escResult.matchedPattern,
                    };
                }
            }
        }
        return { action: "allow" };
    }
    if (tool === "read") {
        if (!args.path)
            return { action: "allow" };
        // Read deny patterns from config
        const denyGlobs = policies.flatMap(p => p.deny.map(d => {
            const parsed = parseToolPattern(d);
            return parsed?.tool === "Read" ? parsed.glob : "";
        })).filter(Boolean);
        const result = evaluateFilePath(args.path, [denyGlobs]);
        if (result.denied) {
            return {
                action: "deny",
                reason: `Blocked by Read deny pattern: "${result.matchedPattern}"`,
                matchedPattern: result.matchedPattern,
            };
        }
        return { action: "allow" };
    }
    if (tool === "webfetch") {
        return {
            action: "context",
            additionalContext: "WebFetch is discouraged. Consider using ctx_execute with fetch() or ctx_index for web content.",
        };
    }
    // Default: allow all other tools
    return { action: "allow" };
}
