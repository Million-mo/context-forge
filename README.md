# context_forge

A workspace for building, experimenting with, and composing AI coding assistant plugins.

> **定位：AI 编程助手的上下文生命周期管理平台。** 在上下文窗口有限的前提下，
> 让 AI 能记住更长的对话历史、精确召回关键信息，并大幅降低 token 成本。
> 三条产品线：`ctx_plugin`（实时压缩）、`mcp_ctx_tool`（执行 + 知识库索引）、
> `mcp_ctx_summary`（短期会话记忆：压缩存储 + 无损召回）。
>
> 详见 [docs/product-value.md](docs/product-value.md) — 完整产品价值分析，含两个 MCP 的边界说明。

---

## What's Inside

### ctx_plugin

A unified opencode plugin combining:

- **RTK** — intercepts `bash`/`shell` tool calls and rewrites commands via `rtk rewrite` before execution
- **Caveman** — ultra-compressed communication mode with session-level persistence across six intensity levels, from casual tight prose to 文言文 classical Chinese
- **Security** — layered policy engine (deny/allow patterns + shell-escape scanning)

See [ctx_plugin/README.md](ctx_plugin/README.md) for full details.

### Skills

Located under `ctx_plugin/skills/`:

| Skill | Type | Description |
|-------|------|-------------|
| `caveman` | 核心 | 每次回复压缩风格，减少 ~65-75% token 输出 |
| `cavecrew` | 核心 | 子 agent 决策：何时派发给 caveman 风格的 subagent |
| `caveman-commit` | 按需 | Commit message 生成（`/caveman-commit`） |
| `caveman-review` | 按需 | Code review（`/caveman-review`） |
| `caveman-compress` | 按需 | 文本压缩（`/caveman-compress`） |
| `caveman-help` | 按需 | 帮助/引导 |

**推荐配置**：至少保留 `caveman` + `cavecrew`，其他按需手动激活。

---

## MCP Server

A single unified MCP server — `mcp_context_forge` — combines execution, content indexing, and session memory.

| Group | Tool | Description |
|-------|------|-------------|
| **exec** | `ctx_execute` | 沙箱执行代码（11 种语言，100MB 输出上限） |
| | `ctx_execute_file` | 执行脚本文件（路径穿越保护） |
| | `ctx_batch_execute` | 批量顺序/并行执行 |
| | `ctx_runtimes` | 列出可用运行时及版本 |
| **index** | `ctx_index` | 将文件或文本索引到 FTS5 存储 |
| | `ctx_search` | BM25 + trigram RRF 融合搜索 |
| | `ctx_fetch_and_index` | 抓取网页内容并索引 |
| | `ctx_stats` | 存储统计信息 |
| **memory** | `summary_recall` | 意图驱动的 LLM 语义召回 |
| | `summary_search` | FTS5 全文搜索摘要 |
| | `summary_list` | 列出某会话的所有摘要 |
| | `summary_get` | 按会话 ID 和轮次获取单个摘要 |
| | `summary_messages` | 获取某轮次的原始消息（无损） |
| | `ctx_session` | 会话分析 + resume 快照 |
| **infra** | `ctx_doctor` | 系统诊断 |
| | `ctx_ping` | 健康检查 |
| | `ctx_purge` | 清理会话数据 |
| | `summary_health` | 摘要 DB 统计 |

**支持语言：** `javascript`, `typescript`, `python`, `shell`, `ruby`, `go`, `rust`, `php`, `perl`, `r`, `elixir`

> 旧版 `mcp_ctx_tool` 和 `mcp_ctx_summary` 已合并，详见 [DEPRECATED.md](mcps/mcp_ctx_tool/DEPRECATED.md)。

---

## Quick Start

```bash
# 1. 安装依赖并构建
cd mcps/mcp_context_forge
npm install && npm run build
cd ../..

# 2. 注册到 opencode.json
npx tsx scripts/install-all.ts

# 3. 重启 opencode
```

---

## Architecture

```
context_forge/
├── README.md
├── mcps/
│   ├── mcp_context_forge/         # 统一 MCP 服务器
│   │   └── src/
│   │       ├── server.ts          # 18 tools, 4 groups (exec/index/memory/infra)
│   │       ├── summary-queries.ts # 摘要 DB 查询（从旧 MCP 提取）
│   │       └── install.ts
│   ├── mcp_ctx_tool/              # [DEPRECATED] 源码作为库供统一 MCP 引用
│   │   └── src/
│   │       ├── executor.ts        # PolyglotExecutor 沙箱执行器
│   │       ├── runtime.ts         # 运行时检测（11 种语言）
│   │       ├── store.ts           # ContentStore FTS5 索引
│   │       ├── session-db.ts      # 会话事件存储
│   │       └── session/           # extract, snapshot, analytics
│   ├── mcp_ctx_summary/           # [DEPRECATED] 源码作为库供统一 MCP 引用
│   │   └── src/
│   │       └── recall-prompts.ts
│   └── shared-types/              # 共享类型 + DB + LLM 客户端
│       └── src/
│           ├── db.ts              # 统一 SQLite 封装
│           ├── llm-client.ts      # 统一 LLM API 客户端
│           ├── config.ts          # 统一配置加载
│           ├── paths.ts           # XDG 路径解析
│           ├── schema.ts          # SQLite schema
│           ├── prompts.ts         # LLM 提示词
│           └── install-helper.ts
├── ctx_plugin/                    # opencode 插件（RTK + Caveman + Transform）
│   ├── src/
│   │   ├── index.ts              # barrel export
│   │   ├── caveman.ts            # Caveman 压缩模式插件
│   │   ├── routing-plugin.ts     # Routing + 安全策略插件
│   │   ├── rtk.ts                # RTK 指令重写插件
│   │   ├── transform.ts          # Transform 消息压缩插件
│   │   ├── cli.ts                # install/status CLI
│   │   ├── security.ts           # 策略引擎 + shell-escape 扫描
│   │   └── hooks/
│   │       ├── routing.ts         # 工具路由决策
│   │       ├── guidance.ts        # 会话级引导节流
│   │       └── tool-naming.ts     # 工具名标准化
│   └── skills/
│       ├── caveman/              # 6 档压缩强度
│       ├── cavecrew/              # 子 agent 决策
│       ├── caveman-commit/
│       ├── caveman-review/
│       ├── caveman-compress/
│       └── caveman-help/
└── scripts/
    └── install-all.ts            # 一键安装统一 MCP
```

---

## Requirements

- [opencode](https://github.com/opencode-ai/opencode)
- Node.js ≥ 18 or Bun
- (Optional) [RTK](https://github.com/rtk-ai/tinykt) for command rewriting

---

## Configuration

### MCP Server (`opencode.json`)

```json
{
  "mcp": {
    "mcp_context_forge": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcps/mcp_context_forge/dist/server.js"]
    }
  }
}
```

Feature flags (optional env vars):
- `CTX_DISABLE_EXECUTION=1` — skip execution tools
- `CTX_DISABLE_MEMORY=1` — skip memory tools (no summaries.db required)

### Security Policy (`settings.json`)

```json
{
  "permissions": {
    "allow": ["Bash(pwd)", "Bash(git status)"],
    "deny": ["Bash(sudo *)"],
    "ask": []
  }
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CTX_PLUGIN_REQUIRE_SECURITY` | `1` = 策略匹配时 fail-closed |
| `CTX_PLUGIN_DATA_DIR` | 覆盖会话 DB 基目录 |
| `CTX_PLUGIN_VERBOSE` | `1` = 输出调试日志 |
| `CAVEMAN_DEFAULT_MODE` | 默认压缩级别（`full`, `ultra`, `wenyan` 等） |
| `OPENCODE_CONFIG_DIR` | 覆盖 opencode 配置目录 |
