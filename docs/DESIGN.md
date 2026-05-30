# Context Forge 设计规范

> 最后更新：2025-07-28  
> 涵盖：数据库架构、配置体系、组件设计、CLI 规范

---

## 1. 数据库架构

项目使用 **3 个独立 SQLite 数据库**，全部嵌入式部署，零外部依赖。

| # | 数据库 | 路径 | 引擎 | 用途 |
|---|---|---|---|---|
| 1 | 会话事件存储 | `~/.ctx_plugin/data/sessions/<hash>.db` | `node:sqlite` | 工具调用追踪、节流控制 |
| 2 | FTS5 内容索引 | `<项目>/.ctx_plugin/data/content.db` | `node:sqlite` + FTS5 | BM25 全文搜索（porter + trigram 双分词，RRF 融合） |
| 3 | LLM 摘要库 | `<项目>/.ctx_plugin/data/summaries.db` | `node:sqlite`(写) + `better-sqlite3`(读) + FTS5 | 对话回合摘要 + 意图召回 |

### 1.1 会话事件存储

- 表：`events`、`sessions`、`tool_calls`
- 事件类型：`tool_call`、`redirect`、`guidance`、`security_block`、`session_start`、`session_end`
- 每会话最多 500 条事件，超出删 10%
- PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`cache_size=-64000`、`temp_store=MEMORY`
- 路径受 `CTX_PLUGIN_DATA_DIR` 环境变量控制

### 1.2 FTS5 内容索引

- 表：`chunks`（FTS5 porter）、`chunks_trigram`（FTS5 trigram）、`sources`
- 内容按标题拆分 chunks（≤4096 字），SHA-256 去重
- 搜索：porter BM25 → trigram BM25 → RRF 融合 → LIKE 回退
- 支持 `code` / `prose` 类型过滤

### 1.3 LLM 摘要库

- 表：`global_summary_cache`、`session_turn_summaries`、`summaries_fts`（FTS5）、`turn_messages`
- FTS5 含 `AFTER INSERT/DELETE/UPDATE` 同步触发器
- 写入端：`transform.mjs`（opencode 插件），`chat.message` hook 触发
- 读取端：`mcp_ctx_summary` MCP 服务器，提供 6 个工具

---

## 2. 配置体系

### 2.1 目录结构

```
~/.ctx_plugin/                      ← 全局配置 + 数据（XDG 规范）
├── config.json                     ← 所有组件共享的全局默认配置
├── caveman-active                  ← caveman 运行时 flag（纯文本，≤64 字节）
└── data/
    └── sessions/                   ← 会话事件 SQLite

<项目>/.ctx_plugin/                 ← 项目级配置 + 数据
├── config.json                     ← 覆盖全局配置（apiKey 等敏感信息）
├── log/                            ← transform 日志
└── data/
    ├── summaries.db                ← LLM 对话摘要
    └── content.db                  ← FTS5 全文索引
```

### 2.2 配置优先级

```
环境变量 > .ctx_plugin/config.json > config.json (legacy) > ~/.ctx_plugin/config.json > 默认值
```

### 2.3 config.json 统一格式

```json
{
  "llm": {
    "provider": "openai",
    "model": "GLM-4.7",
    "apiKey": "",
    "baseUrl": "http://116.204.104.177:8123",
    "maxTokens": 2048,
    "temperature": 0.3
  },
  "caveman": {
    "defaultMode": "full"
  },
  "dataDir": "./data"
}
```

### 2.4 环境变量（统一前缀 `CONTEXT_FORGE_*`）

| 变量 | 用途 | Legacy 别名 |
|---|---|---|
| `CONTEXT_FORGE_LLM_API_KEY` | LLM API key | `TRANSFORM_LLM_API_KEY`、`LLM_API_KEY` |
| `CONTEXT_FORGE_LLM_BASE_URL` | LLM 接口地址 | `TRANSFORM_LLM_BASE_URL`、`LLM_BASE_URL` |
| `CONTEXT_FORGE_LLM_MODEL` | LLM 模型名 | `TRANSFORM_LLM_MODEL`、`LLM_MODEL` |
| `CAVEMAN_DEFAULT_MODE` | caveman 默认级别 | — |
| `CTX_PLUGIN_CONFIG_DIR` | 全局配置目录 | — |
| `CTX_PLUGIN_DATA_DIR` | 全局数据目录 | — |
| `DATA_DIR` | 项目数据目录覆盖 | — |
| `TRANSFORM_DATA_DIR` | transform 数据目录覆盖 | — |

### 2.5 共享模块

- `mcps/shared-types/src/paths.ts` — 统一 XDG 路径解析（10 个导出函数），消除 9 处重复
- `mcps/shared-types/src/config.ts` — 统一 `loadConfig()`，含 `loadLLMConfig()` / `loadCavemanConfig()` 快捷方式
- MCP 服务器通过 `@context-forge/shared-types` npm 包引用
- opencode 插件（caveman.ts、transform.ts）内联最小路径逻辑（运行时不能 import workspace 包）

---

## 3. 组件规范

### 3.1 mcp_ctx_tool

**MCP 服务器**，提供沙箱代码执行 + FTS5 全文搜索。

**11 个工具**：

| 工具 | 功能 |
|---|---|
| `ctx_ping` | 健康检查 |
| `ctx_execute` | 执行代码片段（11 种语言） |
| `ctx_execute_file` | 执行脚本文件（自动识别 shebang/扩展名） |
| `ctx_batch_execute` | 批量执行（顺序/并行可选） |
| `ctx_runtimes` | 列出可用运行时 |
| `ctx_index` | 索引文件或内容 |
| `ctx_content_search` | BM25 + trigram RRF 融合搜索 |
| `ctx_content_stats` | 内容库统计 |
| `ctx_fetch` | 抓取网页并索引 |
| `ctx_purge` | 清理会话数据 |
| `ctx_doctor` | 系统诊断 |

**沙箱安全**：
- 20+ 危险环境变量被过滤（`LD_PRELOAD`、`NODE_OPTIONS`、`RUSTFLAGS` 等）
- 输出硬截断：100MB
- 超时 kill：`killTree` 进程组
- 进程隔离：`detached: true`

### 3.2 mcp_ctx_summary

**MCP 服务器**，读取 `summaries.db` 提供对话摘要检索。

**6 个工具**：

| 工具 | 功能 |
|---|---|
| `ctx_recall` | 意图驱动 LLM 召回 |
| `ctx_summary_search` | FTS5 全文搜索摘要 |
| `ctx_summary_list` | 列出会话所有摘要 |
| `ctx_summary_get` | 获取单轮摘要 |
| `ctx_summary_messages` | 获取原始消息 |
| `ctx_health` | 健康检查 + DB 统计 |

### 3.3 transform 插件

**opencode 插件**（`transform.mjs`），负责：

1. **压缩消息历史**：对话超过 TOKEN_BUDGET（8000）时压缩旧轮次
2. **生成对话摘要**：每轮对话完成后异步调 LLM → 写入 `summaries.db`
3. **历史上下文注入**：检测用户消息中的回顾意图 → 自动注入相关历史摘要

**触发时机**：每次 `chat.message` hook 触发，非阻塞

**LLM 配置**：`env > .ctx_plugin/config.json > config.json (legacy) > ~/.ctx_plugin/config.json > 默认值`

**压缩策略**（4 级，基于衰减评分）：

| 级别 | 触发条件 | 行为 |
|---|---|---|
| `full` | 评分 < 2 | 保留完整输出 |
| `summary` | 评分 < 5 | 保留首尾 3 行 |
| `placeholder` | 评分 < 8 | 显示文件名 + 行数 |
| `minimal` | 评分 ≥ 8 | 仅显示文件名 |

### 3.4 caveman 插件

**opencode 插件**（`caveman.mjs`），超压缩通信模式。

**6 个压缩级别**：`lite` → `full` → `ultra` → `wenyan-lite` → `wenyan` → `wenyan-ultra`

**3 个独立一次性模式**（斜杠命令保留）：
- `/caveman-commit` — terse commit messages
- `/caveman-review` — 单行 code review
- `/caveman-compress` — 文本压缩

**运行时控制**（CLI，替代了 `/caveman <level>` 斜杠命令）：
```bash
ctx_plugin caveman on           # 以默认级别激活
ctx_plugin caveman off          # 关闭
ctx_plugin caveman ultra        # 切换到指定级别
ctx_plugin caveman status       # 查看当前模式
```

**触发**：
- `session.created` → 写入 `~/.ctx_plugin/caveman-active` flag
- `chat.message` → 检测 flag → 追加压缩提示；解析自然语言切换（`activate caveman` / `stop caveman`）

### 3.5 routing 插件

**opencode 插件**（`routing.mjs`），安全策略 + 工具路由。

---

## 4. CLI 规范

### 4.1 命令总览

```bash
ctx_plugin install [caveman|routing|transform]    # 安装插件
ctx_plugin uninstall [caveman|routing|transform]  # 卸载插件
ctx_plugin caveman [on|off|<level>]               # caveman 运行时控制
ctx_plugin caveman status                         # caveman 状态
ctx_plugin status                                  # 全局状态
ctx_plugin doctor                                  # 诊断
ctx_plugin security                                # 安全策略
```

### 4.2 安装流程

1. `ctx_plugin install <component>` → 运行 `build-plugins.mjs`（tsc 编译 + strip types）
2. 输出 `.mjs` 到 `~/.config/opencode/plugins/`
3. `install-caveman.js` 额外复制 skills/ + agents/ + 生成 `~/.ctx_plugin/config.json`

### 4.3 构建流程

1. `npm run build` → `tsc` 把所有 `.ts` 编译到 `dist/`
2. `build-plugins.mjs` → 复制 `dist/*.js` → `~/.config/opencode/plugins/*.mjs`，strip 残留类型

---

## 5. 数据流

```
opencode 会话
    │
    ├─ caveman.mjs ──→ 读/写 ~/.ctx_plugin/caveman-active（运行时 flag）
    │                 读 ~/.ctx_plugin/config.json（默认级别）
    │
    ├─ transform.mjs ─→ 压缩消息历史（衰减评分）
    │                 ─→ 调 LLM 生成摘要 → 写入 .ctx_plugin/data/summaries.db
    │                 ─→ 检测回顾意图 → FTS5 搜索 → 注入历史上下文
    │
    ├─ routing.mjs ──→ 安全策略检查 → 工具路由
    │
    ├─ mcp_ctx_tool ─→ 沙箱执行（11 种语言）
    │                ─→ FTS5 索引/搜索
    │                ─→ 会话事件记录
    │
    └─ mcp_ctx_summary ─→ 读取 summaries.db
                        ─→ ctx_recall（LLM 意图召回）
                        ─→ ctx_summary_search（FTS5 搜索）
```

---

## 6. 设计原则

1. **零外部数据库**：全部 SQLite，不需要 PostgreSQL/Redis/MySQL
2. **配置优于环境变量**：`config.json` 优先，env var 仅做覆盖
3. **XDG 规范**：`~/.ctx_plugin/` 全局配置，`<项目>/.ctx_plugin/` 项目配置
4. **优先本地、回退全局、最后默认**：配置加载链清晰分层
5. **opencode 插件内联**：不能 import workspace 包，路径逻辑内联但代码一致
6. **异步非阻塞**：摘要生成、LLM 调用均为异步，不影响对话体验
7. **静默降级**：LLM 不可用时跳过摘要，不报错、不阻塞
