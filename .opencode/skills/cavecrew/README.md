# cavecrew

Delegate tasks to caveman-style subagents. **Saves main-context tokens** when you need code search, surgical edits, or diff review.

## 与 caveman 的区别

| | caveman | cavecrew |
|--|---------|----------|
| **作用** | 控制你的回复风格 | 控制是否派生子 agent |
| **生效** | 每次回复 | 特定任务才触发 |

**cavecrew 依赖 caveman** — 子 agent 输出用 caveman 风格（约 1/3 正常大小），注入主上下文时消耗更少。

## 为什么需要它

Subagent 输出会被完整注入你的上下文窗口。

```
不用 cavecrew:  Explore 返回 2000 tokens → 上下文消耗 2000 tokens
用 cavecrew:    investigator 返回 100 tokens → 上下文消耗 100 tokens
```

20 次调用差距：40k vs 2k tokens。

三个子 agent：

| 子 agent | 职责 | 何时用 |
|----------|------|--------|
| `cavecrew-investigator` | 定位代码（只读） | "X 在哪定义"、"谁调用了 Y"、"Z 在哪些地方用到" |
| `cavecrew-builder` | 精准修改 1-2 个文件 | 范围明确，≤2 文件。拒绝 3+ 文件改动 |
| `cavecrew-reviewer` | Diff / 文件审查 | 带 severity emoji 的单行 findings |

需要详细解释、架构分析或理由时，用原生 `Explore` 或 `Code Reviewer`。简单问题和 3+ 文件重构直接在主线程处理。

## 触发方式

以下短语会触发：delegate to subagent, use cavecrew, spawn investigator, save context, compressed agent output。

## 典型用法

定位 → 修复 → 验证（最常用）：

1. `cavecrew-investigator` 返回位置列表（`path:line — symbol — note`）
2. 主线程选取 1-2 个位置，把路径交给 `cavecrew-builder`
3. `cavecrew-reviewer` 审查最终 diff

并行侦察：一次发送 2-3 个不同角度的 `cavecrew-investigator`（定义、调用者、测试）。主线程汇总结果。

## See also

- [`SKILL.md`](./SKILL.md) — full decision matrix and output contracts
- [`agents/cavecrew-investigator.md`](../../agents/cavecrew-investigator.md)
- [`agents/cavecrew-builder.md`](../../agents/cavecrew-builder.md)
- [`agents/cavecrew-reviewer.md`](../../agents/cavecrew-reviewer.md)
- [Caveman README](../../README.md) — repo overview
