# context_forge

A workspace for building, experimenting with, and composing AI coding assistant plugins.

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

## MCP Servers

Located under `mcps/`:

| Package | Tools | Description |
|---------|-------|-------------|
| `mcp_ctx_tool` | 10 tools | 沙箱多语言代码执行 + FTS5 内容索引/搜索 |
| `mcp_ctx_summary` | 6 tools | 会话摘要召回 + 全局 FTS 搜索 |

### mcp_ctx_tool

| Tool | Description |
|------|-------------|
| `ctx_ping` | 健康检查 |
| `ctx_execute` | 沙箱执行代码（11 种语言，100MB 输出上限） |
| `ctx_runtimes` | 列出可用运行时及版本 |
| `ctx_index` | 将文件或文本索引到 FTS5 存储 |
| `ctx_search` | BM25 + trigram RRF 融合搜索 |
| `ctx_stats` | 存储统计信息 |
| `ctx_execute_file` | 执行脚本文件 |
| `ctx_batch_execute` | 批量顺序/并行执行 |
| `ctx_fetch_and_index` | 抓取网页内容并索引 |
| `ctx_purge` | 清理会话数据 |

**支持语言：** `javascript`, `typescript`, `python`, `shell`, `ruby`, `go`, `rust`, `php`, `perl`, `r`, `elixir`

### mcp_ctx_summary

| Tool | Description |
|------|-------------|
| `summary_recall` | 意图驱动的召回（通过 LLM 生成） |
| `summary_search` | 全局 FTS 全文搜索摘要 |
| `summary_list` | 列出某会话的所有摘要 |
| `summary_get` | 按会话 ID 和轮次获取单个摘要 |
| `summary_messages` | 获取某轮次的原始消息 |
| `summary_health` | 健康检查 + DB 统计 |

---

## Quick Start

```bash
# 1. 安装依赖并构建
cd mcps/mcp_ctx_tool
npm install && npm run build
cd ../mcp_ctx_summary
npm install && npm run build
cd ../..

# 2. 注册到 opencode.json
npx tsx scripts/install-all.ts

# 或分别安装
node mcps/mcp_ctx_tool/dist/install.js
node mcps/mcp_ctx_summary/dist/install.js

# 3. 重启 opencode
```

---

## Architecture

```
context_forge/
├── README.md
├── mcps/                          # MCP 服务器包
│   ├── mcp_ctx_tool/              # 代码执行 + FTS5 搜索
│   │   └── src/
│   │       ├── server.ts           # MCP stdio 服务端
│   │       ├── executor.ts         # PolyglotExecutor 沙箱执行器
│   │       ├── runtime.ts         # 运行时检测（11 种语言）
│   │       ├── store.ts           # FTS5 BM25 + trigram RRF 搜索
│   │       ├── session-db.ts      # SQLite 会话事件存储
│   │       ├── db-base.ts         # SQLite 基础封装
│   │       ├── install.ts         # 注册到 opencode.json
│   │       └── types.ts
│   ├── mcp_ctx_summary/           # 上下文摘要 + 召回
│   │   └── src/
│   │       ├── server.ts          # MCP stdio 服务端
│   │       ├── llm.ts             # 召回 LLM 客户端
│   │       ├── recall-prompts.ts  # 召回提示词
│   │       ├── install.ts         # 注册到 opencode.json
│   │       └── types.ts
│   └── shared-types/              # 共享 TypeScript 类型
├── ctx_plugin/                    # opencode 插件（RTK + Caveman）
│   ├── src/
│   │   ├── plugin.ts             # opencode 插件入口
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
    └── install-all.ts            # 一键安装两个 MCP
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
    "mcp_ctx_tool": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcps/mcp_ctx_tool/dist/server.js"]
    },
    "mcp_ctx_summary": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcps/mcp_ctx_summary/dist/server.js"]
    }
  }
}
```

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
