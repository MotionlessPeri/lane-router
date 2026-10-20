import { z } from "zod";
import type { CallerContext } from "../router/types.js";
import { flattenRootUnion } from "./flat-root-schema.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
}
export interface ToolCallOptions { readonly rejectTakeover?: boolean }
export type ToolHandler = (name: string, args: Record<string, unknown>, context: CallerContext, signal?: AbortSignal, options?: ToolCallOptions) => unknown | Promise<unknown>;
export interface ApplicationTools {
  readonly catalog: ToolCatalog;
  call: ToolHandler;
}

/**
 * Definitions are pure data; binding handlers never changes the published directory. The
 * instructions are what a conversation is told at its start about using these tools: the parts
 * arrive with the tools they are about, so a catalog without a module's tools never carries its rules.
 */
export class ToolCatalog {
  readonly definitions: readonly ToolDefinition[];
  private readonly byName = new Map<string, ToolDefinition>();

  constructor(definitions: readonly ToolDefinition[], readonly instructions = "") {
    for (const definition of definitions) {
      if (this.byName.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
      this.byName.set(definition.name, definition);
    }
    this.definitions = [...definitions];
  }

  /** This catalog plus a module's tools, and that module's instructions after these when it has any. */
  extend(definitions: readonly ToolDefinition[], instructions?: string): ToolCatalog {
    return new ToolCatalog([...this.definitions, ...definitions], [this.instructions, instructions ?? ""].filter(Boolean).join("\n\n"));
  }

  has(name: string): boolean { return this.byName.has(name); }

  parse(name: string, input: unknown): Record<string, unknown> {
    const definition = this.byName.get(name);
    if (!definition) throw new Error(`Unknown Lane Router tool: ${name}`);
    return definition.schema.parse(input) as Record<string, unknown>;
  }

  jsonTools(target?: "draft-7") {
    return this.definitions.map(definition => {
      const schema = z.toJSONSchema(definition.schema, target === undefined ? {} : { target }) as Record<string, unknown>;
      const flat = flattenRootUnion(schema);
      return flat === undefined
        // MCP requires an object root.
        ? { name: definition.name, description: definition.description, inputSchema: { ...schema, type: "object" as const } }
        : { name: definition.name, description: `${definition.description}\n\n${flat.combinations}`, inputSchema: flat.schema };
    });
  }

  bind(handler: ToolHandler): ApplicationTools {
    return { catalog: this, call: async (name, args, context, signal, options) => handler(name, this.parse(name, args), context, signal, options) };
  }
}
