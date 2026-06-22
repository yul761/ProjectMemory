import { describe, it, expect } from "vitest";
import { z, ZodError } from "zod";
import { parseOutput } from "./output";

const schema = z.object({ a: z.string() });

describe("parseOutput", () => {
  it("returns the parsed value when it matches the schema", () => {
    expect(parseOutput(schema, { a: "ok" })).toEqual({ a: "ok" });
  });

  it("throws a non-ZodError on a contract violation (so it maps to a logged 500, not 400)", () => {
    let thrown: unknown;
    try {
      parseOutput(schema, { a: 123 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ZodError);
    expect((thrown as Error).cause).toBeInstanceOf(ZodError);
  });
});
