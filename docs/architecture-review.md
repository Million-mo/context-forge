# Context Forge — 架构评审

> 评审日期：2025-07  
> 评审范围：`ctx_plugin/` + `mcps/` 全部组件

---

## 一、整体印象

**一个设计意图清晰、但执行一致性不足的系统。** 三条产品线的分层思路正确（实时压缩 → 执行索引 → 会话记忆），模块间没有循环依赖，依赖图是一个干净的 DAG。但跨组件的重复代码、不一致的数据库访问层、以及"最佳努力"式的错误处理策略，表明系统在快速增长过程中缺乏重构窗口。

**评分：** 架构意图 ⭐⭐⭐⭐ / 执行一致性 ⭐⭐

---

## 二、耦合分析

### 依赖拓扑（无循环依赖 ✓）

```
shared-types  ←──  mcp_ctx_summary (types + config, 运行时依赖)
              ←──  mcp_ctx_tool     (仅 getContentDbPath, 弱依赖)

ctx_plugin    →   不依赖 mcps/ 中的任何代码
              →   通过构建时注入消费 shared-types/schema
```

这是正确的分层：`shared-types` 是最底层，MCP 服务器消费它，`ctx_plugin` 通过构建时注入解耦。**没有循环依赖。**

### 问题点

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| 1 | **重复路由代码 ~40 行** | `routing-plugin.ts` | 中 |
| 2 | **transform.ts 对 shared-types 无编译时依赖** | `ctx_plugin/package.json` | 中 |
| 3 | `mcp_ctx_tool` 只用了 shared-types 的一个函数 | `store.ts:1` | 低 |

#### 问题 1：routing-plugin.ts 的双路径导入

[`routing-plugin.ts`](ctx_plugin/src/routing-plugin.ts:67-115) 中 `getRouting()` 先用 `await import()` 动态加载，失败后进入一个静态 `try/catch` 块再次 `require` 并重复调用相同函数。两段逻辑 ~40 行几乎相同。**任何路由逻辑的修改都需要改两处。**

#### 问题 2：构建时注入解耦太"干净"

`transform.ts` 通过构建脚本 `build-plugins.mjs` 注入 `__CTX_SUMMARIES_DB_SCHEMA__` 占位符，绕过了对 `@context-forge/shared-types` 的运行时依赖。这很聪明，但副作用是：

- `ctx_plugin/package.json` 中没有 `@context-forge/shared-types` 依赖声明
- schema 变更时不会触发 `ctx_plugin` 的类型检查失败
- 需要跑构建才能发现 schema 不兼容

---

## 三、数据库架构

### 三库三引擎

| 数据库 | 路径 | 写入方 | 读取方 | SQLite 引擎 |
|--------|------|--------|--------|-------------|
| `summaries.db` | `<project>/.ctx_plugin/data/` | `ctx_plugin/transform.ts` | `mcp_ctx_summary` | `node:sqlite` (写) / `better-sqlite3` (读) |
| `content.db` | `<project>/.ctx_plugin/data/` | `mcp_ctx_tool` 用户调用 | `mcp_ctx_tool` | `node:sqlite` (custom wrapper) |
| `<hash>.db` | `~/.local/share/ctx_plugin/sessions/` | `mcp_ctx_tool` 自动记录 | `mcp_ctx_tool` | `node:sqlite` (custom wrapper) |

### 问题点

| # | 问题 | 严重度 |
|---|------|--------|
| 1 | **三种 SQLite 封装并存** | 高 |
| 2 | 数据库路径计算逻辑不一致 | 中 |
| 3 | `node:sqlite` 和 `better-sqlite3` 并发读写无锁 | 中 |
| 4 | 会话 DB 文件名只有 16 位哈希 | 低 |

#### 问题 1：三种 SQLite 封装

- `ctx_plugin/transform.ts` — 直接用 `node:sqlite` 的 `DatabaseSync`
- `mcps/mcp_ctx_tool/db-base.ts` — 自定义 `Database` wrapper（封装了 `node:sqlite`）
- `mcps/mcp_ctx_summary/server.ts` — 用第三方 `better-sqlite3`

三个组件、同一个底层引擎（SQLite）、三种访问方式。`db-base.ts` 的 wrapper 如果提取到 `shared-types`，可统一 `mcp_ctx_tool` 和 `mcp_ctx_summary` 的 DB 层。

#### 问题 3：并发风险

`ctx_plugin/transform.ts` 和 `mcp_ctx_summary/server.ts` 同时打开 `summaries.db`，前者写、后者读。两边用不同的绑定（`node:sqlite` vs `better-sqlite3`），都开 WAL 模式所以目前安全——但如果 WAL 被关闭或有一方忘记启用，就会出现 `SQLITE_BUSY`。

---

## 四、重复代码

这是架构层面最显著的技术债务。

| # | 重复内容 | 出现次数 | 位置 |
|---|---------|---------|------|
| 1 | LLM API 调用模式（构建 Headers → POST → 解析 response） | **3 次** | `transform.ts`, `llm.ts`, `.opencode/plugins/caveman.mjs` |
| 2 | 中文摘要 System/User Prompts | **2 次** | `transform.ts` (内联), `shared-types/prompts.ts` (规范) |
| 3 | 配置加载逻辑（env → file fallback） | **3 次** | `transform.ts`, `mcp_ctx_summary/config.ts`, `.opencode/plugins/hooks/` |
| 4 | 工具安装脚本 | **2 次** | `mcp_ctx_tool/install.ts`, `mcp_ctx_summary/install.ts` |
| 5 | 工具调用分类逻辑 | **2 次** | `mcp_ctx_tool/session/extract.ts`, `ctx_plugin` hooks |

### 最值得修复的重复：LLM API 调用

三个地方都在做同一件事：`POST {baseUrl}/v1/chat/completions` + Bearer token + AbortController 超时。差异仅在于错误处理粒度。提取到 `shared-types` 的一个 `OpenAIClient` 类可消除 ~120 行重复代码，并统一错误处理行为。

---

## 五、错误处理策略

**系统级设计决策：静默失败（fail-silent）。** 几乎所有 try/catch 都走 `// best-effort` 或空 catch 块。

```typescript
// 典型模式 — 在 session-db.ts, extract.ts, server.ts 中反复出现
try {
  insertEvent(ev);
} catch {
  // best-effort only
}
```

### 评估

这**不是一个 bug，而是一个架构选择**，背后有合理的动机：

- session 事件记录失败不应阻塞工具调用
- LLM 摘要生成失败不应中断消息流
- 数据库写入失败不应让整个 MCP 服务器崩溃

但这个选择的**代价**是：

1. **没有故障可见性。** 当 session DB 损坏或 LLM API 密钥过期时，系统静默降级，运维者无从得知。
2. **调试困难。** 同样的静默失败可能在三个不同组件中发生，排查时需要在每个 `catch {}` 块加日志。
3. **测试困难。** 无法通过返回值或异常来验证副作用的成功/失败。

### 建议

至少需要一条**错误遥测通道**——不是打印日志，而是将错误事件统一发送到一个可观测的出口（结构化日志文件或一个 `ctx_error` MCP 工具），让 agent 可以主动检查系统健康状态。

---

## 六、类型系统

| 组件 | 类型来源 | 一致性 |
|------|---------|--------|
| `mcp_ctx_summary` | `@context-forge/shared-types` | ✅ 完全一致 |
| `mcp_ctx_tool` | 本地 `types.ts` + 部分 shared-types | ⚠️ 混合 |
| `ctx_plugin/transform.ts` | 本地内联类型 | ❌ 独立定义 |

`mcp_ctx_summary` 是类型使用最规范的组件——所有类型从 `shared-types` 导入，`TurnSummary`、`StoredMessage`、`RecallResult` 统一定义。

`mcp_ctx_tool` 有自己的 `types.ts`（`ExecResult`、`Language`、`RuntimeMap`），这些类型与 summary 无关所以独立定义合理。但它同时也复制了 session event 类型，这些其实可以共享。

`ctx_plugin/transform.ts` 在文件内部重定义了 `TurnSummary`、`ActionEntry`、`ArtifactChange`——与 `shared-types` 中完全一致。Schema 通过构建时注入解决了，但类型定义仍然是独立维护的。

---

## 七、配置管理

三个组件各自加载配置，优先级链不同：

| 组件 | 加载顺序 |
|------|---------|
| `ctx_plugin/transform.ts` | `env.CONTEXT_FORGE_LLM_*` → `env.TRANSFORM_LLM_*`(legacy) → `.ctx_plugin/config.json` → `config.json` → `~/.ctx_plugin/config.json` |
| `mcp_ctx_summary` | `shared-types/loadConfig()` → 仅 `.ctx_plugin/config.json` |
| `.opencode/plugins/hooks/` | 各自通过 `process.env` 读取 |

**同一个 LLM API 密钥可能从三条不同路径加载，得到三个不同结果。** 这不是 bug（多数情况下读取的是同一个 config.json），但缺乏单一的配置入口点。

---

## 八、总结与建议

### 架构优势

1. **DAG 依赖图无循环** — 分层清晰，重构安全性高
2. **MCP 协议解耦** — 两个 MCP 独立可插拔，消费者可以是任何 MCP 客户端
3. **双 FTS5 + RRF 搜索设计** — 技术选型有深度，不是简单的 LIKE 查询
4. **插件端构建时注入** — 避免循环依赖的巧妙手段（虽然代价是类型安全）
5. **安全沙箱设计** — 环境变量净化 + 路径穿越双层防护，安全不是附加项

### 优先修复项

| 优先级 | 问题 | 工作量 | 影响 |
|--------|------|--------|------|
| **P0** | 提取统一的 LLM API 客户端到 shared-types | 2h | 消除 ~120 行重复，统一错误处理 |
| **P0** | 统一三个 SQLite 封装到 shared-types/db.ts | 3h | 消除引擎分歧，降低并发风险 |
| **P1** | transform.ts 的类型改为从 shared-types 导入 | 1h | 消除类型重复，编译时检查 |
| **P1** | routing-plugin.ts 消除双路径导入 | 30min | 消除维护隐患 |
| **P2** | 建立错误遥测通道（结构化日志 / ctx_doctor 增强） | 2h | 故障可见性 |
| **P2** | 统一配置加载入口 | 1h | 消除配置加载分歧 |