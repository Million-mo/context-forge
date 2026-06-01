/**
 * One-shot installer for Context Forge MCP.
 *
 * Usage:
 *   npx tsx scripts/install-all.ts           (install + guided config)
 *   npx tsx scripts/install-all.ts --skip-config  (MCP only, skip config)
 *   npx tsx scripts/install-all.ts --uninstall    (remove)
 *
 * Registers mcp_context_forge into opencode.json MCP config.
 */

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const UNINSTALL = process.argv.includes("--uninstall");
const SKIP_CONFIG = process.argv.includes("--skip-config");

function runScript(relPath, extraArgs = [], label) {
  const scriptPath = resolve(__dirname, relPath);
  if (!existsSync(scriptPath)) {
    if (label) console.warn(`  ! ${label} not found: ${scriptPath}, skipping`);
    return false;
  }
  const labelText = label ?? relPath;
  console.log(`\n[install-all] ${labelText}`);
  console.log(`  $ tsx ${relPath} ${extraArgs.join(" ")}`);
  try {
    execSync(`npx tsx "${scriptPath}" ${extraArgs.join(" ")}`, {
      cwd: ROOT,
      stdio: "inherit",
    });
    console.log(`  ✓ ${labelText} done`);
    return true;
  } catch {
    console.error(`  ✗ ${labelText} failed`);
    return false;
  }
}

function installMcp() {
  console.log("=== Installing Context Forge MCP Server ===\n");

  const forgeInstall = resolve(ROOT, "mcps", "mcp_context_forge", "dist", "install.js");
  if (!existsSync(forgeInstall)) {
    console.error("  ! mcp_context_forge install script not found.");
    console.error("    Build first:");
    console.error("      cd mcps/mcp_context_forge && npm install && npm run build");
    console.error("    Or use the unified build:");
    console.error("      npm run build:server");
    process.exit(1);
  }

  try {
    execSync(`node "${forgeInstall}"`, {
      cwd: resolve(ROOT, "mcps", "mcp_context_forge"),
      stdio: "inherit",
    });
    console.log("  ✓ mcp_context_forge registered");
  } catch (err) {
    console.error("  ✗ mcp_context_forge registration failed");
    process.exit(1);
  }
}

function uninstallMcp() {
  console.log("=== Uninstalling Context Forge MCP ===\n");
  const forgeInstall = resolve(ROOT, "mcps", "mcp_context_forge", "dist", "install.js");
  if (existsSync(forgeInstall)) {
    try {
      execSync(`node "${forgeInstall}" --uninstall`, {
        cwd: resolve(ROOT, "mcps", "mcp_context_forge"),
        stdio: "inherit",
      });
      console.log("  ✓ mcp_context_forge unregistered");
    } catch { /* already gone */ }
  }
}

async function setupLlmConfig() {
  const configPath = resolve(ROOT, ".ctx_plugin", "config.json");
  let existing = null;
  try {
    if (existsSync(configPath)) {
      const raw = await import("node:fs").then((fs) => fs.readFileSync(configPath, "utf-8"));
      existing = JSON.parse(raw);
    }
  } catch { /* ignore */ }

  if (existing?.llm?.apiKey) {
    console.log("\n[setup-config] 检测到已有 LLM 配置，跳过交互式配置。");
    console.log(`  ${configPath}`);
    console.log(`  API: ${existing.llm.apiKey.slice(0, 8)}... @ ${existing.llm.baseUrl}/${existing.llm.model}`);
    console.log("  如需重新配置，运行: npx tsx scripts/setup-config.ts\n");
    return;
  }

  const hasEnvKey =
    process.env.CONTEXT_FORGE_LLM_API_KEY ||
    process.env.TRANSFORM_LLM_API_KEY ||
    process.env.LLM_API_KEY;

  if (hasEnvKey) {
    console.log("\n[setup-config] 检测到环境变量中的 LLM API Key，正在写入配置...");
    runScript("setup-config.ts", ["--noninteractive"], "setup-config (from env)");
    return;
  }

  console.log("\n" + "=".repeat(58));
  console.log("  摘要生成需要配置 LLM API");
  console.log("=".repeat(58));
  console.log("\n已跳过交互式配置。可通过以下方式配置：");
  console.log("  方式 1（推荐）：运行配置向导");
  console.log("    npx tsx scripts/setup-config.ts");
  console.log();
  console.log("  方式 2：直接编辑配置文件");
  console.log(`    cp config.json.example .ctx_plugin/config.json`);
  console.log(`    # 然后编辑 .ctx_plugin/config.json 填入 API Key`);
  console.log();
  console.log("  方式 3：设置环境变量");
  console.log("    export CONTEXT_FORGE_LLM_API_KEY=your-key");
  console.log("    export CONTEXT_FORGE_LLM_BASE_URL=https://...");
  console.log("    export CONTEXT_FORGE_LLM_MODEL=gpt-4o");
  console.log();
}

async function main() {
  if (UNINSTALL) {
    uninstallMcp();
    console.log("\n=== All removed ===\n");
  } else {
    installMcp();
    if (!SKIP_CONFIG) {
      await setupLlmConfig();
    }
    console.log("\n=== All done ===");
    console.log("重启 opencode 以加载新的 MCP 服务器。\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
