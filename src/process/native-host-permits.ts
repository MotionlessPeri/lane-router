import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { parseLaneAddress } from "../router/address.js";
import { nativeHostPermitSchema, type NativeHostPermit } from "./native-external-contract.js";

/** Permit contents never become an error message, including parser and filesystem failures. */
export function validateNativeHostPermits(value: unknown): NativeHostPermit[] {
  const parsed = z.array(nativeHostPermitSchema).safeParse(value);
  if (!parsed.success) throw new Error("NATIVE_HOST_PERMITS_INVALID");
  try { parsed.data.forEach(permit => parseLaneAddress(permit.address)); }
  catch { throw new Error("NATIVE_HOST_PERMITS_INVALID"); }
  for (const field of ["token", "hostInstanceId", "address"] as const) {
    if (new Set(parsed.data.map(permit => permit[field])).size !== parsed.data.length) throw new Error("NATIVE_HOST_PERMITS_INVALID");
  }
  return parsed.data;
}

export async function readNativeHostPermits(options: {
  dataRoot: string; nativeHostsFile?: string; nativeHosts?: readonly NativeHostPermit[];
}): Promise<NativeHostPermit[] | undefined> {
  if (options.nativeHostsFile !== undefined && options.nativeHosts !== undefined) throw new Error("NATIVE_HOST_PERMITS_AMBIGUOUS");
  if (options.nativeHostsFile === undefined) return options.nativeHosts === undefined ? undefined : validateNativeHostPermits(options.nativeHosts);
  let text: string;
  try { text = await readFile(resolve(options.dataRoot, options.nativeHostsFile), "utf8"); }
  catch { throw new Error("NATIVE_HOST_PERMITS_UNREADABLE"); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("NATIVE_HOST_PERMITS_INVALID"); }
  return validateNativeHostPermits(value);
}
