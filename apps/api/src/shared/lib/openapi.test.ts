import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { z } from "zod";
import { describeRoute, errors, jsonPaged, jsonRequestBody, pageMetaSchema } from "./openapi";

async function specFor(responses: ReturnType<typeof jsonPaged>) {
  const app = new Hono();
  app.get("/things", describeRoute({ responses }), c => c.json({}));
  return generateSpecs(app);
}

describe("jsonPaged", () => {
  test("documents the default page meta", async () => {
    const spec = await specFor(jsonPaged(z.object({
      id: z.string(),
    })));
    const schema = JSON.stringify(spec.paths["/things"]?.get?.responses?.[200]);
    expect(schema).toContain("\"total\"");
    expect(schema).not.toContain("\"hasMore\"");
  });

  test("documents an extended page meta", async () => {
    const meta = pageMetaSchema.extend({
      hasMore: z.boolean(),
    });
    const spec = await specFor(jsonPaged(z.object({
      id: z.string(),
    }), "Page", meta));
    const schema = JSON.stringify(spec.paths["/things"]?.get?.responses?.[200]);
    expect(schema).toContain("\"hasMore\"");
  });
});

describe("errors", () => {
  test("describes each status, falling back to a generic label", () => {
    const out = errors(404, 410, 418);
    expect(out[404]?.description).toBe("Not found");
    expect(out[410]?.description).toBe("Gone");
    expect(out[418]?.description).toBe("Error");
  });
});

describe("jsonRequestBody", () => {
  test("emits a JSON schema without the $schema marker", () => {
    const body = jsonRequestBody(z.object({
      name: z.string(),
    }));
    const schema = body.content["application/json"]?.schema as Record<string, unknown>;
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
  });
});
