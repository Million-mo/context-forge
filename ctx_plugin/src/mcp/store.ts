/**
 * ContentStore - FTS5 BM25-based knowledge base for ctx_plugin.
 *
 * Chunks content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 */

import { Database } from "./db-base.js";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer?: "porter" | "trigram" | "fuzzy" | "rrf" | "rrf-fuzzy";
  highlighted?: string;
}

export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
}

export interface StoreStats {
  totalSources: number;
  totalChunks: number;
  codeChunks: number;
  dbSizeBytes: number;
}

interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "update", "updates", "updated", "add", "added", "fix", "fixed",
]);

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function sanitizeQuery(query: string): string {
  const words = dedupeTokens(
    query
      .replace(/['"(){}[\]*:^~]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0 && !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()))
  );

  if (words.length === 0) return '""';
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function detectContentType(content: string): "code" | "prose" {
  const codeBlocks = (content.match(/```[\s\S]*?```/g) || []).length;
  const lines = content.split("\n");
  const codeLines = lines.filter((l) => l.trim().startsWith("```")).length;
  const linesWithCode = lines.filter(
    (l) => /^(import|export|const|let|var|function|class|def|public|private|if|for|while)\s/.test(l.trim())
  ).length;

  return codeBlocks > 2 || linesWithCode > 3 ? "code" : "prose";
}

function splitIntoChunks(content: string, maxChunkSize = 4096): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = content.split("\n");
  let currentChunk = "";
  let currentTitle = "Untitled";

  // Try to detect title from first heading
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      currentTitle = headingMatch[2].trim();
      break;
    }
  }

  let chunkStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);

    // Start new chunk on heading or if current chunk exceeds max size
    if (
      headingMatch ||
      currentChunk.length + line.length > maxChunkSize
    ) {
      if (currentChunk.trim()) {
        chunks.push({
          title: currentTitle,
          content: currentChunk.trim(),
          hasCode: detectContentType(currentChunk) === "code",
        });
      }
      if (headingMatch) {
        currentTitle = headingMatch[2].trim();
      }
      currentChunk = line + "\n";
      chunkStartLine = i;
    } else {
      currentChunk += line + "\n";
    }
  }

  // Push remaining chunk
  if (currentChunk.trim()) {
    chunks.push({
      title: currentTitle,
      content: currentChunk.trim(),
      hasCode: detectContentType(currentChunk) === "code",
    });
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

export class ContentStore {
  #db: Database;
  #dbPath: string;

  constructor(projectDir: string) {
    // Create directory if it doesn't exist
    const dbDir = join(projectDir, ".ctx_plugin");
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    this.#dbPath = join(dbDir, "content.db");
    this.#db = new Database(this.#dbPath);
    this.#init();
  }

  #init(): void {
    // Create FTS5 virtual table with porter stemming and trigram
    this.#db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id,
        content_type,
        source_label,
        chunk_hash,
        tokenize='porter unicode61 remove_diacritics 1'
      );
    `);

    this.#db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id,
        content_type,
        source_label,
        chunk_hash,
        tokenize='trigram'
      );
    `);

    // Create sources table
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        file_path TEXT,
        content_hash TEXT NOT NULL,
        chunk_count INTEGER DEFAULT 0,
        code_chunk_count INTEGER DEFAULT 0,
        indexed_at TEXT NOT NULL
      );
    `);

    // Create index on source_label (only on regular tables)
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);
  }

  async index(content: string, opts?: { source?: string; title?: string }): Promise<IndexResult> {
    const label = opts?.source ?? "memory";
    const chunks = splitIntoChunks(content);
    const contentHash = hashContent(content);
    const now = new Date().toISOString();

    return this.#db.transaction(() => {
      // Check if source with same hash exists
      const existing = this.#db.prepare(
        "SELECT id FROM sources WHERE label = ? AND content_hash = ?"
      ).get(label, contentHash);

      if (existing) {
        return {
          sourceId: (existing as { id: number }).id,
          label,
          totalChunks: chunks.length,
          codeChunks: chunks.filter((c) => c.hasCode).length,
        };
      }

      // Insert new source
      const insertSource = this.#db.prepare(
        "INSERT INTO sources (label, content_hash, chunk_count, code_chunk_count, indexed_at) VALUES (?, ?, ?, ?, ?)"
      );
      const sourceResult = insertSource.run(
        label,
        contentHash,
        chunks.length,
        chunks.filter((c) => c.hasCode).length,
        now
      );
      const sourceId = Number(sourceResult.lastInsertRowid);

      // Insert chunks into both FTS tables
      const insertChunk = this.#db.prepare(
        "INSERT INTO chunks (title, content, source_id, content_type, source_label, chunk_hash) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const insertTrigram = this.#db.prepare(
        "INSERT INTO chunks_trigram (title, content, source_id, content_type, source_label, chunk_hash) VALUES (?, ?, ?, ?, ?, ?)"
      );

      for (const chunk of chunks) {
        const chunkHash = hashContent(chunk.content);
        const contentType = chunk.hasCode ? "code" : "prose";
        insertChunk.run(chunk.title, chunk.content, sourceId, contentType, label, chunkHash);
        insertTrigram.run(chunk.title, chunk.content, sourceId, contentType, label, chunkHash);
      }

      return {
        sourceId,
        label,
        totalChunks: chunks.length,
        codeChunks: chunks.filter((c) => c.hasCode).length,
      };
    });
  }

  async indexFile(filePath: string, opts?: { source?: string }): Promise<IndexResult> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    const content = readFileSync(filePath, "utf-8");
    const source = opts?.source ?? filePath;

    return this.index(content, { source });
  }

  search(query: string, limit = 10, opts?: { source?: string; contentType?: "code" | "prose" }): SearchResult[] {
    if (!query.trim()) return [];

    const sanitized = sanitizeQuery(query);
    const { source, contentType } = opts ?? {};

    try {
      // BM25 search with RRF fusion of porter + trigram
      const sql = `
        WITH porter_results AS (
          SELECT title, content, source_label, content_type,
                 bm25(chunks, '${sanitized}', 10.0) as bm25_score,
                 row_number() OVER (ORDER BY bm25(chunks, '${sanitized}', 10.0)) as porter_rank
          FROM chunks
          WHERE chunks MATCH '${sanitized}'
          ${source ? `AND source_label = '${source.replace(/'/g, "''")}'` : ""}
          ${contentType ? `AND content_type = '${contentType}'` : ""}
        ),
        trigram_results AS (
          SELECT title, content, source_label, content_type,
                 bm25(chunks_trigram, '${sanitized}', 10.0) as bm25_score,
                 row_number() OVER (ORDER BY bm25(chunks_trigram, '${sanitized}', 10.0)) as trigram_rank
          FROM chunks_trigram
          WHERE chunks_trigram MATCH '${sanitized}'
          ${source ? `AND source_label = '${source.replace(/'/g, "''")}'` : ""}
          ${contentType ? `AND content_type = '${contentType}'` : ""}
        )
        SELECT
          p.title,
          p.content,
          p.source_label as source,
          p.content_type as contentType,
          p.porter_rank,
          t.trigram_rank,
          COALESCE(1.0 / (60 + p.porter_rank), 0) + COALESCE(1.0 / (60 + t.trigram_rank), 0) as rrf_score
        FROM porter_results p
        LEFT JOIN trigram_results t ON p.content = t.content
        ORDER BY rrf_score DESC
        LIMIT ${limit}
      `;

      const results = this.#db.prepare(sql).all() as Array<{
        title: string;
        content: string;
        source: string;
        contentType: string;
        porter_rank: number;
        trigram_rank: number | null;
        rrf_score: number;
      }>;

      return results.map((row, idx) => ({
        title: row.title,
        content: row.content,
        source: row.source,
        rank: idx + 1,
        contentType: row.contentType as "code" | "prose",
        matchLayer: row.trigram_rank ? "rrf" : "porter",
      }));
    } catch {
      // Fallback to simple LIKE search if FTS fails
      return this.#fallbackSearch(query, limit, opts);
    }
  }

  #fallbackSearch(query: string, limit: number, opts?: { source?: string; contentType?: "code" | "prose" }): SearchResult[] {
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (tokens.length === 0) return [];

    const conditions = tokens.map((t) => `content LIKE '%${t.replace(/'/g, "''")}%'`);
    const whereClause = conditions.join(" AND ");

    const sql = `
      SELECT title, content, source_label as source, content_type as contentType,
             LENGTH(content) as relevance
      FROM chunks
      WHERE ${whereClause}
      ${opts?.source ? `AND source_label = '${opts.source.replace(/'/g, "''")}'` : ""}
      ${opts?.contentType ? `AND content_type = '${opts.contentType}'` : ""}
      ORDER BY relevance DESC
      LIMIT ${limit}
    `;

    const results = this.#db.prepare(sql).all() as Array<{
      title: string;
      content: string;
      source: string;
      contentType: string;
      relevance: number;
    }>;

    return results.map((row, idx) => ({
      title: row.title,
      content: row.content,
      source: row.source,
      rank: idx + 1,
      contentType: row.contentType as "code" | "prose",
      matchLayer: "fuzzy" as const,
    }));
  }

  getStats(): StoreStats {
    const sources = this.#db.prepare("SELECT COUNT(*) as count FROM sources").get() as { count: number };
    const chunks = this.#db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
    const codeChunks = this.#db.prepare(
      "SELECT COUNT(*) as count FROM chunks WHERE content_type = 'code'"
    ).get() as { count: number };

    return {
      totalSources: sources.count,
      totalChunks: chunks.count,
      codeChunks: codeChunks.count,
      dbSizeBytes: existsSync(this.#dbPath) ? statSync(this.#dbPath).size : 0,
    };
  }

  clear(): void {
    this.#db.exec("DELETE FROM chunks");
    this.#db.exec("DELETE FROM chunks_trigram");
    this.#db.exec("DELETE FROM sources");
  }

  close(): void {
    this.#db.close();
  }
}
