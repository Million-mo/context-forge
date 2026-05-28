/**
 * Summary MCP config — thin wrapper over shared-types.
 *
 * All path resolution and config loading lives in @context-forge/shared-types.
 * This file just re-exports with the project dir pinned.
 */

import { loadConfig } from "@context-forge/shared-types/config"
import { getSummariesDbPath, getProjectDataDir } from "@context-forge/shared-types/paths"
import type { LLMConfig } from "@context-forge/shared-types"

export type { LLMConfig }

const _config = loadConfig()

export const DATA_DIR = process.env.DATA_DIR || getProjectDataDir()

export function getDbPath(): string {
  return getSummariesDbPath()
}

export { _config as config }
