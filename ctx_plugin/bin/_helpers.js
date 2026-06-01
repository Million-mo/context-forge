/**
 * ctx_plugin install helpers — shared across all install scripts
 */
import { execSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ── path resolution ──────────────────────────────────────────────────

// Project root (two levels up from bin/)
const __HELPERS_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__HELPERS_DIR, "..", "..")

export function opencodeDir() {
  return join(PROJECT_ROOT, ".opencode")
}

// ── json helpers ────────────────────────────────────────────────────

export function readJson(path) {
  const raw = readFileSync(path, "utf8")
  const cleaned = raw.replace(/\/\/[^\n]*/g, "")
  try {
    return JSON.parse(cleaned)
  } catch {
    return {}
  }
}

export function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n")
}

// ── rtk check ───────────────────────────────────────────────────────

export function rtkAvailable() {
  try {
    execSync("which rtk", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

// ── file helpers ────────────────────────────────────────────────────

export function copyDirRecursive(src, dst) {
  mkdirSync(dst, { recursive: true })
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const dstPath = join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath)
    } else {
      copyFileSync(srcPath, dstPath)
    }
  }
}

export function rpad(label, width) {
  return label.padEnd(width, " ")
}

export function section(name) {
  console.log(`\n## ${name}`)
}
