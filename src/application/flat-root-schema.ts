import { isDeepStrictEqual } from "node:util";

type JsonSchema = Record<string, unknown>;
type Branch = JsonSchema & { readonly properties: Record<string, JsonSchema>; readonly required?: readonly string[] };

/**
 * Clients rewrite a root anyOf/oneOf before the model sees it (Claude Code kept one const per field),
 * so a union's object branches are published as one object root. The rules that fold loses, which
 * value needs which fields, go into the description as one line per branch. Parsing still uses the
 * Zod union; nested unions are left alone because clients show those as they are.
 */
export function flattenRootUnion(schema: JsonSchema): { readonly schema: JsonSchema & { readonly type: "object" }; readonly combinations: string } | undefined {
  const { anyOf, oneOf, ...rest } = schema;
  const branches = anyOf ?? oneOf;
  if (!Array.isArray(branches) || branches.length === 0 || !branches.every(isObjectBranch)) return undefined;
  const fields = new Map<string, JsonSchema[]>();
  for (const branch of branches) for (const [field, property] of Object.entries(branch.properties)) fields.set(field, [...fields.get(field) ?? [], property]);
  const properties = Object.fromEntries([...fields].map(([field, variants]) => [field, mergeField(variants)]));
  const required = [...new Set(branches.flatMap(branch => branch.required ?? []))].filter(field => branches.every(branch => branch.required?.includes(field)));
  return {
    schema: { ...rest, type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false },
    combinations: ["Argument combinations (use exactly one):", ...branches.map((branch, index) => `${index + 1}. ${combination(branch)}`)].join("\n"),
  };
}

function isObjectBranch(value: unknown): value is Branch {
  return typeof value === "object" && value !== null && (value as JsonSchema).type === "object"
    && typeof (value as JsonSchema).properties === "object" && (value as JsonSchema).properties !== null;
}

function mergeField(variants: readonly JsonSchema[]): JsonSchema {
  const distinct = variants.filter((variant, index) => variants.findIndex(other => isDeepStrictEqual(other, variant)) === index);
  if (distinct.length === 1) return distinct[0]!;
  const withoutValues = distinct.map(({ const: _const, enum: _enum, ...other }) => other);
  if (distinct.every(variant => "const" in variant || Array.isArray(variant.enum)) && withoutValues.every(other => isDeepStrictEqual(other, withoutValues[0]))) {
    const values = distinct.flatMap(variant => "const" in variant ? [variant.const] : variant.enum as unknown[]);
    return { ...withoutValues[0], enum: values.filter((value, index) => values.findIndex(other => isDeepStrictEqual(other, value)) === index) };
  }
  return { anyOf: distinct };
}

function combination(branch: Branch): string {
  const entries = Object.entries(branch.properties);
  const values = entries.filter(([, property]) => "const" in property).map(([field, property]) => `${field}=${JSON.stringify(property.const)}`);
  const required = entries.filter(([field, property]) => !("const" in property) && branch.required?.includes(field)).map(([field]) => field);
  const optional = entries.filter(([field, property]) => !("const" in property) && !branch.required?.includes(field)).map(([field]) => field);
  const fields = [...required.length === 0 ? [] : [required.join(", ")], ...optional.length === 0 ? [] : [`optional: ${optional.join(", ")}`]].join("; ");
  return values.length === 0 ? fields : fields === "" ? values.join(", ") : `${values.join(", ")}: ${fields}`;
}
