import type { z } from "zod";

export function parseOutput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // A response that violates its own contract is a SERVER bug, not a client
    // error. Throw a non-ZodError so GlobalErrorFilter routes it to a logged
    // 500 rather than the ZodError→400 branch (which is for request input).
    throw new Error(`Response contract violation: ${result.error.message}`, {
      cause: result.error
    });
  }
  return result.data;
}
