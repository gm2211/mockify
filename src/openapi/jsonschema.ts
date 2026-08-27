/**
 * src/openapi/jsonschema.ts — Shape -> JSON Schema (OpenAPI 3.1 subset)
 *
 * OpenAPI 3.1's Schema Object *is* JSON Schema (2020-12 dialect), so this is
 * a direct structural translation of synthesize/schema.ts's Shape (the
 * response-shape inference the synthesis step already computes) into plain
 * JSON Schema objects — no OpenAPI-specific vocabulary involved. Kept
 * separate from build.ts so the shape->schema mapping can be tested and
 * reasoned about independently of endpoint/path assembly.
 */

import type { Shape } from '../synthesize/schema.js';

/** A JSON Schema fragment. Loosely typed (JSON Schema's own vocabulary is
 * large and this only ever emits a small, known subset) — see
 * shapeToJsonSchema for exactly which keywords appear. */
export type JsonSchema = Record<string, unknown>;

/** Cap on how many observed values become `examples` on a schema — mirrors
 * the spirit of Shape's own POOL_CAP (schema.ts) but smaller, since these
 * are meant to be a handful of illustrative samples in a human-facing spec
 * rather than a synthesis data pool. */
const EXAMPLE_CAP = 5;

function capExamples(pool: unknown[]): unknown[] {
  return pool.slice(0, EXAMPLE_CAP);
}

/** Convert one inferred Shape (from synthesize/schema.ts's inferShape) into
 * a JSON Schema fragment. Recurses for object/array; primitives carry a
 * capped `examples` array drawn from the values actually observed in the
 * capture. An `unknown` shape (no samples, e.g. an always-absent optional
 * key) becomes `{}` — JSON Schema's "no constraint" schema, which OpenAPI
 * 3.1 permits directly since it inherited full JSON Schema semantics. */
export function shapeToJsonSchema(shape: Shape): JsonSchema {
  switch (shape.type) {
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, { shape: valueShape, optional }] of Object.entries(shape.keys)) {
        properties[key] = shapeToJsonSchema(valueShape);
        if (!optional) required.push(key);
      }
      const schema: JsonSchema = { type: 'object', properties };
      if (required.length > 0) schema.required = required;
      return schema;
    }
    case 'array':
      return { type: 'array', items: shapeToJsonSchema(shape.element) };
    case 'string': {
      const schema: JsonSchema = { type: 'string' };
      const examples = capExamples(shape.pool);
      if (examples.length > 0) schema.examples = examples;
      return schema;
    }
    case 'number': {
      const schema: JsonSchema = { type: 'number' };
      const examples = capExamples(shape.pool);
      if (examples.length > 0) schema.examples = examples;
      return schema;
    }
    case 'boolean': {
      const schema: JsonSchema = { type: 'boolean' };
      const examples = capExamples(shape.pool);
      if (examples.length > 0) schema.examples = examples;
      return schema;
    }
    case 'null':
      return { type: 'null' };
    case 'unknown':
    default:
      return {};
  }
}
