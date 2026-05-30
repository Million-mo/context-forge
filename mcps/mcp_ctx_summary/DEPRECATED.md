# DEPRECATED

**mcp_ctx_summary has been merged into [`mcp_context_forge`](../mcp_context_forge/).**

The query logic has been extracted to `mcp_context_forge/src/summary-queries.ts`. The standalone MCP server is no longer maintained.

To migrate:
```bash
# Uninstall old MCP
node mcps/mcp_ctx_summary/dist/install.js --uninstall

# Install unified MCP
npx tsx scripts/install-all.ts
```
