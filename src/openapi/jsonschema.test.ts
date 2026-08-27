import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { shapeToJsonSchema } from './jsonschema.js';
import { inferShape } from '../synthesize/schema.js';

test('shapeToJsonSchema: object shape -> properties + required (non-optional keys only)', () => {
  const shape = inferShape([
    JSON.stringify({ id: 1, name: 'Sprocket', inStock: true }),
    JSON.stringify({ id: 2, name: 'Cog' }), // inStock missing here -> optional
  ]);
  const schema = shapeToJsonSchema(shape);

  assert.equal(schema.type, 'object');
  const properties = schema.properties as Record<string, { type: string }>;
  assert.equal(properties.id.type, 'number');
  assert.equal(properties.name.type, 'string');
  assert.equal(properties.inStock.type, 'boolean');

  const required = schema.required as string[];
  assert.ok(required.includes('id'));
  assert.ok(required.includes('name'));
  assert.ok(!required.includes('inStock'), 'inStock was absent on one sample and must not be required');
});

test('shapeToJsonSchema: array shape -> items schema from merged element shape', () => {
  const shape = inferShape([JSON.stringify([{ id: 1 }, { id: 2 }])]);
  const schema = shapeToJsonSchema(shape);
  assert.equal(schema.type, 'array');
  const items = schema.items as { type: string; properties: Record<string, unknown> };
  assert.equal(items.type, 'object');
  assert.ok('id' in items.properties);
});

test('shapeToJsonSchema: primitive shapes carry a capped examples array drawn from observed values', () => {
  const shape = inferShape(['"a"', '"b"', '"c"', '"d"', '"e"', '"f"', '"g"']);
  const schema = shapeToJsonSchema(shape);
  assert.equal(schema.type, 'string');
  assert.ok(Array.isArray(schema.examples));
  assert.ok((schema.examples as unknown[]).length <= 5, 'examples must be capped');
});

test('shapeToJsonSchema: null shape -> {type: "null"}', () => {
  const shape = inferShape(['null']); // a JSON body that's literally `null` -> {type: 'null', pool: [null]}
  const schema = shapeToJsonSchema(shape);
  assert.equal(schema.type, 'null');
});

test('shapeToJsonSchema: unknown shape -> {} (JSON Schema "no constraint", valid under OpenAPI 3.1)', () => {
  const schema = shapeToJsonSchema({ type: 'unknown' });
  assert.deepEqual(schema, {});
});

test('shapeToJsonSchema: nested object/array round trips a realistic capture shape', () => {
  const shape = inferShape([JSON.stringify({ widgets: [{ id: 1, name: 'Sprocket' }, { id: 2, name: 'Cog' }] })]);
  const schema = shapeToJsonSchema(shape);
  assert.equal(schema.type, 'object');
  const widgets = (schema.properties as Record<string, { type: string; items: { type: string } }>).widgets;
  assert.equal(widgets.type, 'array');
  assert.equal(widgets.items.type, 'object');
});
