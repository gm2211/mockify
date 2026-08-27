import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { toYaml, fromYaml, type JsonValue } from './yaml.js';

test('toYaml: golden output for a small mixed-type document', () => {
  const doc = {
    str: 'hello',
    num: 42,
    float: 1.5,
    bool: true,
    nil: null,
    list: ['a', 'b'],
    nested: { x: 1, y: 2 },
    emptyArr: [] as JsonValue[],
    emptyObj: {},
  };
  const yaml = toYaml(doc);
  assert.equal(
    yaml,
    [
      'str: hello',
      'num: 42',
      'float: 1.5',
      'bool: true',
      'nil: null',
      'list:',
      '  - a',
      '  - b',
      'nested:',
      '  x: 1',
      '  y: 2',
      'emptyArr: []',
      'emptyObj: {}',
      '',
    ].join('\n')
  );
});

test('toYaml: quotes strings that would otherwise be ambiguous plain scalars', () => {
  const doc = {
    looksLikeMapping: 'key: value',
    looksLikeNumber: '123',
    looksLikeBool: 'true',
    trailingColon: 'ends:',
    empty: '',
  };
  const yaml = toYaml(doc);
  assert.match(yaml, /looksLikeMapping: "key: value"/);
  assert.match(yaml, /looksLikeNumber: "123"/);
  assert.match(yaml, /looksLikeBool: "true"/);
  assert.match(yaml, /trailingColon: "ends:"/);
  assert.match(yaml, /empty: ""/);
});

test('toYaml: array of objects — first key inlines after "- ", rest align under it', () => {
  const doc = { items: [{ a: 1, b: 2 }, { a: 3, b: 4 }] };
  const yaml = toYaml(doc);
  assert.equal(yaml, ['items:', '  - a: 1', '    b: 2', '  - a: 3', '    b: 4', ''].join('\n'));
});

test('toYaml: drops keys whose value is undefined, mirroring JSON.stringify', () => {
  const doc: Record<string, JsonValue | undefined> = { a: 1, b: undefined, c: 2 };
  const yaml = toYaml(doc as unknown as JsonValue);
  assert.doesNotMatch(yaml, /\bb\b/);
  assert.match(yaml, /a: 1/);
  assert.match(yaml, /c: 2/);
});

test('fromYaml(toYaml(x)) round-trips scalars, nested objects, and arrays', () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Test API', version: '1.0.0' },
    paths: {
      '/api/widgets/{id}': {
        get: {
          operationId: 'get_widgets_id',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'number' }, name: { type: 'string', examples: ['a', 'b'] } },
                    required: ['id'],
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const yaml = toYaml(doc as unknown as JsonValue);
  const parsed = fromYaml(yaml);
  assert.deepEqual(parsed, doc);
});

test('fromYaml: round-trips values containing YAML-ambiguous characters (colons, quotes)', () => {
  const doc = { message: 'status: "degraded"', ratio: 0.5, negative: -3, list: [1, 'two', false, null] };
  const parsed = fromYaml(toYaml(doc as unknown as JsonValue));
  assert.deepEqual(parsed, doc);
});

test('fromYaml: empty array/object round trip', () => {
  const doc = { items: [] as unknown[], meta: {} };
  const parsed = fromYaml(toYaml(doc as unknown as JsonValue));
  assert.deepEqual(parsed, doc);
});
