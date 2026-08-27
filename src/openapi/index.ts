/**
 * src/openapi/index.ts — public surface of the OpenAPI export feature
 * (SP-lsc.9): turn a capture into an OpenAPI 3.1 document, and serialize it
 * as YAML (default) or JSON.
 */

export {
  buildOpenApiDocument,
  type BuildOpenApiOptions,
  type OpenApiDocument,
  type OpenApiPathItem,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiMediaType,
  type OpenApiRequestBody,
  type OpenApiResponse,
} from './build.js';
export { toYaml, fromYaml, type JsonValue } from './yaml.js';
export { shapeToJsonSchema, type JsonSchema } from './jsonschema.js';

import type { OpenApiDocument } from './build.js';
import { toYaml, type JsonValue } from './yaml.js';

/** Output format for a serialized OpenAPI document, chosen by the CLI from
 * the --out path's extension (".json" -> json, anything else -> yaml). */
export type OpenApiFormat = 'yaml' | 'json';

/** Pick a format from an output path's extension: ".json" -> json,
 * everything else (including no extension) -> yaml, mockify's default. */
export function formatFromPath(outPath: string): OpenApiFormat {
  return outPath.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
}

/** Serialize an OpenAPI document as YAML or JSON text (always ends with a
 * trailing newline). */
export function serializeOpenApiDocument(doc: OpenApiDocument, format: OpenApiFormat): string {
  if (format === 'json') return JSON.stringify(doc, null, 2) + '\n';
  return toYaml(doc as unknown as JsonValue);
}
