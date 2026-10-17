import { z } from "zod";
import type { CallerContext } from "../router/types.js";

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

/** Definitions are pure data; binding handlers never changes the published directory. */
export class ToolCatalog {
  readonly definitions: readonly ToolDefinition[];
  private readonly byName = new Map<string, ToolDefinition>();

  constructor(definitions: readonly ToolDefinition[]) {
    for (const definition of definitions) {
      if (this.byName.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
      this.byName.set(definition.name, definition);
    }
    this.definitions = [...definitions];
  }

  has(name: string): boolean { return this.byName.has(name); }

  parse(name: string, input: unknown): Record<string, unknown> {
    const definition = this.byName.get(name);
    if (!definition) throw new Error(`Unknown Lane Router tool: ${name}`);
    return definition.schema.parse(input) as Record<string, unknown>;
  }

  jsonTools(target?: "draft-7") {
    return this.definitions.map(definition => ({
      name: definition.name, description: definition.description,
      // MCP requires an object root even when Zod represents strict object branches as anyOf.
      inputSchema: { ...z.toJSONSchema(definition.schema, target === undefined ? {} : { target }), type: "object" as const },
    }));
  }

  bind(handler: ToolHandler): ApplicationTools {
    return { catalog: this, call: async (name, args, context, signal, options) => handler(name, this.parse(name, args), context, signal, options) };
  }
}
