# Context Forge — 设计决策分析

> 从产品和架构双视角审视核心设计选择：为什么是 MCP、为什么拆成两个、以及可能的优化路径。

---

## 一、为什么选择 MCP 作为工具协议

### MCP 的核心特性与本项目的匹配

| MCP 特性 | Context Forge 的利用方式 | 匹配度 |
|----------|------------------------|--------|
| **工具发现**（`ListTools`） | Agent 启动时自动发现所有 `ctx_*` / `summary_*` 工具，无需硬编码 | ★★★ |
| **stdio transport** | MCP 服务器作为子进程运行，无网络端口、无认证、启动即用 | ★★★ |
| **JSON-RPC 语义** | 工具调用天然映射到 request/response，`ctx_execute` 入参即代码、出参即 stdout | ★★★ |
| **框架无关** | 同一个 MCP 可被 OpenCode、Claude Desktop、或其他 MCP 客户端消费 | ★★★ |
| **capabilities 声明** | 服务器声明自己提供 `tools`/`prompts`/`resources`，客户端按需使用 | ★★ |

### 为什么不选其他方案

| 方案 | 缺点 |
|------|------|
| **HTTP REST API** | 需要端口管理、认证、服务发现；Agent 需要硬编码 URL；本地开发时多一层网络开销 |
| **直接 import 库** | 耦合到特定 Agent 框架；无法跨框架复用；代码执行的安全隔离依赖调用方 |
| **gRPC** | 重型协议；JS/TS 生态支持弱于 JSON-RPC；工具发现需要额外机制 |
| **WebSocket** | 连接管理复杂；对于"调用→等待→返回"的 RPC 模式是过度设计 |

**结论：MCP + stdio 是当前最优解。** Context Forge 的工具都是 RPC 式的（调用→等待→返回），不需要流式输出或长连接。stdio 的简单性（子进程 stdin/stdout）完美匹配本地工具服务器的场景。

---

## 二、拆成两个 MCP 的合理性分析

### 当前拆分

```
mcp_ctx_tool (12 tools)              mcp_ctx_summary (6 tools)
├── ctx_execute      执行            ├── summary_recall    语义召回
├── ctx_execute_file 执行文件         ├── summary_search    FTS 摘要搜索
├── ctx_batch_execute 批量执行        ├── summary_list      按会话列出
├── ctx_runtimes     运行时列表       ├── summary_get       单条摘要
├── ctx_index        内容索引         ├── summary_messages  原始消息
├── ctx_search       内容搜索         └── summary_health    健康检查
├── ctx_fetch_and_index Web抓取
├── ctx_stats        索引统计
├── ctx_doctor       系统诊断
├── ctx_ping         健康检查
├── ctx_purge        清理会话
└── ctx_session      会话分析  ←── 语义上属于"记忆"
```

### 拆分的合理性

**支持的论据：**

1. **独立部署。** `mcp_ctx_tool` 可以独立工作——它不需要 `summaries.db` 存在，不需要 LLM API key。用户可以只装执行引擎，不装记忆系统。

2. **独立故障域。** 如果 `mcp_ctx_summary` 因为 LLM API 挂了而超时，`mcp_ctx_tool` 的代码执行不受影响。拆分保护了核心工具路径。

3. **不同数据依赖。** `mcp_ctx_tool` 的数据是自己写入的（`content.db`、session DB），`mcp_ctx_summary` 的数据是 `ctx_plugin` 写入的。拆分反映了数据所有权的边界。

4. **版本独立。** 两个 MCP 可以独立发版，summary 的 LLM 召回策略变更不影响 tool 的执行引擎。

**反对的论据：**

1. **工具发现碎片化。** Agent 从两个服务器分别获取工具列表，没有统一的命名空间。模型需要理解 `ctx_search`（搜内容）和 `summary_search`（搜摘要）的区别——这两个名称并不直观。

2. **ctx_session 归属错误。** `ctx_session` 的会话分析报告和 resume 快照本质上是"记忆"功能，却放在了执行引擎里。这在概念上属于 `mcp_ctx_summary` 的领域。

3. **路由认知不统一。** [`routing.ts`](ctx_plugin/src/hooks/routing.ts) 的 `ROUTING_BLOCK` 把两个 MCP 当作一个来介绍（"When the ctx_plugin MCP server is available"），只提及 `ctx_execute`、`ctx_search`、`ctx_index`，完全没有提到 `summary_*` 工具。这说明路由层本身就没有把两个 MCP 当作平等的一等公民。

4. **运维开销翻倍。** 两个 stdio 进程意味着两个子进程管理、两个 DB 连接池、两份 MCP 握手开销。虽然每个都很轻量，但在资源受限环境下（如 CI）是额外的负担。

5. **"我之前做了什么"需要两个工具。** 要完整回答这个问题，Agent 需要同时调用 `summary_recall`（语义回忆）和 `ctx_session`（结构化统计）。两个工具在两个不同的 MCP 中，Agent 需要知道两者的存在和分工。

### 判断

**拆分利大于弊，但边界画错了。** 正确的边界不是"执行 vs 摘要"，而是：

- `mcp_ctx_tool`：**执行 + 显式知识索引**——纯工具，无记忆语义
- `mcp_ctx_summary`：**全部会话记忆**——摘要 + 会话事件 + resume 快照

也就是把 `ctx_session` 从 tool 挪到 summary 侧。

---

## 三、写端和读端的架构不对称

这里有一个更深层的设计问题：

```
写端（耦合到 Agent 框架）：
  ctx_plugin (OpenCode hooks) ──→ summaries.db
  mcp_ctx_tool 工具调用      ──→ content.db
  mcp_ctx_tool 自动记录      ──→ sessions/<hash>.db

读端（MCP，框架无关）：
  mcp_ctx_summary ──→ summaries.db    (只读)
  mcp_ctx_tool    ──→ content.db      (读写)
  mcp_ctx_tool    ──→ sessions DB     (读写)
```

**mcp_ctx_tool 同时是写端和读端**——它通过工具调用写入数据，再通过工具调用读取数据。这是自然的（索引然后搜索）。

**但 summaries.db 的写端（ctx_plugin）和读端（mcp_ctx_summary）是完全不同的进程、不同的协议、甚至不同的框架。** 这是一个设计上的不对称：写端深度耦合 OpenCode hook 系统，读端却是标准 MCP。

这个不对称**本身不是问题**——它恰恰体现了 Context Forge 的价值主张：记忆的写入是框架相关的（需要在消息流中拦截），但记忆的消费是框架无关的（标准 MCP）。任何支持 MCP 的 Agent 都可以消费 OpenCode 产生的摘要。

**但代价是：如果用户换了一个 Agent 框架（比如从 OpenCode 换到 Claude Desktop），摘要写入就断了。** `mcp_ctx_summary` 仍然是可用的（读取历史数据），但不再产生新摘要。

### 缓解路径

将 `transform.ts` 的逻辑（LLM 摘要生成）也包装为一个 MCP tool——比如 `ctx_summarize_turn`——这样任何 MCP 客户端都可以主动触发摘要生成，而不依赖 OpenCode hook。

---

## 四、架构优化路径

### 路径 A：保持两个 MCP，修正边界（推荐，低风险）

```
mcp_ctx_tool                    mcp_ctx_summary
├── ctx_execute                 ├── summary_recall
├── ctx_execute_file            ├── summary_search
├── ctx_batch_execute           ├── summary_list
├── ctx_runtimes                ├── summary_get
├── ctx_index                   ├── summary_messages
├── ctx_search                  ├── summary_health
├── ctx_fetch_and_index         ├── ctx_session      ← 从 tool 迁入
├── ctx_stats                   └── ctx_resume        ← 从 session 迁入
├── ctx_doctor
├── ctx_ping
└── ctx_purge
```

**改动：** 将 `ctx_session` 和 resume snapshot 逻辑从 `mcp_ctx_tool` 迁移到 `mcp_ctx_summary`，让 summary 成为统一的"会话记忆"入口。

**收益：**
- 边界清晰：tool = 执行 + 索引，summary = 全部记忆
- Agent 问"之前做了什么"只需调 summary 侧的工具
- tool 侧的 session-db.ts 简化为纯写入（不再提供查询接口）

**风险：** `mcp_ctx_summary` 需要额外打开 session DB（目前只打开 `summaries.db`），增加了数据依赖。

### 路径 B：合并为一个 MCP（激进，中等风险）

```
mcp_context_forge (统一入口)
├── exec/          ctx_execute, ctx_execute_file, ctx_batch_execute, ctx_runtimes
├── index/         ctx_index, ctx_search, ctx_fetch_and_index, ctx_stats
├── memory/        summary_recall, summary_search, summary_list, summary_get,
│                  summary_messages, ctx_session, ctx_resume
└── infra/         ctx_doctor, ctx_ping, ctx_purge, summary_health
```

**收益：**
- 统一工具发现——Agent 看到一棵工具树，不会困惑"搜内容用哪个"
- 共享基础设施：一个 DB 连接池、一个 LLM 客户端、一个 config 加载
- 减少进程开销

**风险：**
- 失去独立部署能力——不想用执行引擎的用户也必须启动它
- 故障域合并——LLM 召回挂了会影响代码执行
- 数据依赖混合——summaries.db 不存在时整个 MCP 启动会报错（需要懒加载）

**如果走这条路，需要：**
- 所有数据源改为懒加载（DB 只在首次调用时打开）
- 增加 feature flags（`--disable-execution`，`--disable-memory`）
- 统一的 tool prefix 命名空间

### 路径 C：引入 MCP 间通信（实验性，高风险）

让 `mcp_ctx_summary` 在需要时调用 `mcp_ctx_tool` 的工具（比如 `summary_recall` 内部调用 `ctx_search` 做混合召回）。

**不推荐。** MCP 协议本身不支持服务器间调用，需要自己实现 HTTP 桥接。当前阶段过度设计。

---

## 五、其他架构层面的潜在优化

### 1. ctx_plugin 的 transform.ts 也应该是 MCP 工具

当前 transform.ts 的逻辑只能通过 OpenCode hook 触发。如果把"生成摘要"也暴露为 MCP tool，则：

- 任何 MCP 客户端都可以手动触发摘要生成
- 换 Agent 框架时摘要写入不会断
- 可以在测试中直接调用来验证摘要质量

```typescript
// 新增工具（放在 mcp_ctx_summary 中）
server.registerTool("summary_generate", {
  title: "Generate Turn Summary",
  description: "Manually generate a summary for the current conversation turn",
  inputSchema: { messages: z.array(z.any()) }
}, async (args) => {
  return await generateSummary(args.messages);
});
```

### 2. 路由层应该感知两个 MCP

当前 [`ROUTING_BLOCK`](ctx_plugin/src/hooks/routing.ts:305) 只提及 `ctx_execute` / `ctx_search` / `ctx_index`，没有提及 `summary_*` 工具。应该补充：

```
When you need to recall what was done earlier in this session:
- summary_recall: semantic search across conversation turns
- summary_search: keyword search across summaries
- ctx_session: structured statistics about tool usage
```

### 3. 会话 DB 应该项目本地化

当前 session DB 存储在 `~/.local/share/ctx_plugin/sessions/<hash>.db`（全局），而 summaries.db 和 content.db 在项目本地。sessions 本质上是项目级别的会话记录，放在全局目录的理由并不充分。统一到 `<project>/.ctx_plugin/data/sessions.db` 会简化运维和数据清理。

---

## 六、总结

| 设计决策 | 评价 | 建议 |
|----------|------|------|
| 选择 MCP 作为协议 | ✅ 正确。stdio + JSON-RPC + 工具发现完美匹配需求 | 保持 |
| 拆成两个 MCP | ⚠️ 已修正 | ✅ 已合并为 `mcp_context_forge`（v0.4.0），18 个工具按 4 组（exec/index/memory/infra）统一管理 |
| 写端耦合框架、读端标准 MCP | ✅ 体现价值主张 | 保持，后续可把摘要生成暴露为 MCP tool |
| 三库三 SQLite 引擎 | ✅ 已修正 | 统一到 `shared-types/db.ts`（node:sqlite），删除了 db-base.ts, better-sqlite3 |
| 路由层不感知 summary | ✅ 已修正 | ROUTING_BLOCK 已更新为完整的 18 工具按域分组参考 |
| 会话 DB 全局存储 | ⚠️ 与其他 DB 设计不一致 | 考虑项目本地化 |