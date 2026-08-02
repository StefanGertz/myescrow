import type { Prisma } from "@prisma/client";
import { centsToNumber } from "./currency";

/** Convert database BIGINT values to JSON-safe exact integers at API/storage boundaries. */
export function jsonSafe<T>(value: T): T {
  if (typeof value === "bigint") {
    return centsToNumber(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item)) as T;
  }
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, jsonSafe(item)]),
    ) as T;
  }
  return value;
}

export function jsonObject(value: object): Prisma.InputJsonObject {
  return jsonSafe(value) as Prisma.InputJsonObject;
}
