/**
 * Plugin Registry — the core of the tool plugin architecture.
 *
 * Instead of a giant if/else dispatch in server.ts, each tool is a
 * self-contained plugin registered via `registry.register(Tool)`.
 */

import { z } from "zod";
import type { ToolGroup, ToolResult } from "./types.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  group: ToolGroup;
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  annotations?: ToolAnnotations;
  featureFlag?: "execution";
  handler: (args: unknown) => Promise<ToolResult>;
}

function zodToInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  if (!shape) return { type: "object", properties: {} };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const field = value as z.ZodTypeAny;
    let type = "string";
    let description: string | undefined;

    if ("description" in field && typeof (field as unknown as { description?: string }).description === "string") {
      description = (field as unknown as { description: string }).description;
    }

    if (field instanceof z.ZodString) type = "string";
    else if (field instanceof z.ZodNumber || field instanceof z.ZodEffects) type = "number";
    else if (field instanceof z.ZodBoolean) type = "boolean";
    else if (field instanceof z.ZodArray) type = "array";
    else if (field instanceof z.ZodObject) type = "object";
    else if (field instanceof z.ZodEnum) type = "string";

    const propDef: Record<string, unknown> = { type };
    if (description) propDef.description = description;
    properties[key] = propDef;
    required.push(key);
  }

  return { type: "object", properties, required };
}

export interface FeatureFlags {
  execution: boolean;
}

// Memory tools (summary/recall/session) migrated to ctx_plugin plugin.

export class PluginRegistry {
  #tools: ToolDefinition[] = [];
  #features: FeatureFlags;

  constructor(features: FeatureFlags) {
    this.#features = features;
  }

  register(tool: ToolDefinition): void {
    this.#tools.push(tool);
  }

  getTools(): ToolDefinition[] {
    return this.#tools.filter((tool) => {
      if (tool.featureFlag === "execution" && !this.#features.execution) return false;
      return true;
    });
  }

  listTools(): ToolDefinition[] {
    return this.getTools();
  }

  toMcpToolList(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: ToolAnnotations;
  }> {
    return this.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToInputSchema(tool.inputSchema),
      annotations: tool.annotations ?? {},
    }));
  }

  async handleCall(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.getTools().find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    try {
      return await tool.handler(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${tool.name}] handler error:`, error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  getFeatures(): FeatureFlags {
    return { ...this.#features };
  }
}
