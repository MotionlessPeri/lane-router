import { createHash } from "node:crypto";

export interface LaneDeclaration {
  readonly name: string;
  readonly roleFile: string;
  readonly communicationEntry: boolean;
}

export function declarationDigest(
  declarations: readonly LaneDeclaration[],
): string {
  const canonical = [...declarations]
    .map((declaration) => ({
      communicationEntry: declaration.communicationEntry,
      name: declaration.name,
      roleFile: declaration.roleFile,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
