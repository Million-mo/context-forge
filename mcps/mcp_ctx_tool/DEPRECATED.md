# DEPRECATED

**mcp_ctx_tool has been merged into [`mcp_context_forge`](../mcp_context_forge/).**

The source files under `src/` (executor, store, session-db, runtime, etc.) are retained as internal library code used by the unified MCP. The standalone MCP server is no longer maintained.

To migrate:
```bash
# Uninstall old MCP
node mcps/mcp_ctx_tool/dist/install.js --uninstall

# Install unified MCP
npx tsx scripts/install-all.ts
```
