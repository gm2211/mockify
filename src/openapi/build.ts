/**
 * src/openapi/build.ts — capture -> OpenAPI 3.1 document
 *
 * The synthesis step (src/synthesize/, read-only from here) already infers
 * *endpoint templates* (method + path, with template variables collapsed
 * from observed literal values — see synthesize/templates.ts) and *response
 * shapes* (per-template merged JSON structure — see synthesize/schema.ts).
 * This module is substantially a serializer on top of that: it re-derives
 * template groups from a capture's traffic entries via
 * `inferTemplateGroups` (the same function generateSynthetic() uses to
 * write synthetic/index.json) and turns each group into an OpenAPI Path
 * Item — path parameters from the template's placeholders, query
 * parameters observed across the group's request URLs, a requestBody
 * schema when any entry carried one, and one response per distinct status
 * code observed (not just the modal one generateSynthetic() picks for
 * synthesis) with a JSON Schema built by jsonschema.ts's shapeToJsonSchema.
 *
 * This never touches synthetic/index.json or synthesize/'s exports beyond
 * reading them — no synthesize/ file is modified by this feature.
 */

import type { CapturedTraffic } from '../format/types.js';
import { inferTemplateGroups, type EndpointTemplate } from '../synthesize/templates.js';
import { inferShape } from '../synthesize/schema.js';
import { HOP_BY_HOP_RESPONSE_HEADERS } from '../format/headers.js';
import { shapeToJsonSchema, type JsonSchema } from './jsonschema.js';

// ---------------------------------------------------------------------------
// Document shape (OpenAPI 3.1 — a Schema Object *is* JSON Schema 2020-12)
// ---------------------------------------------------------------------------

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

export interface OpenApiMediaType {
  schema: JsonSchema;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, OpenApiMediaType>;
  headers?: Record<string, { schema: JsonSchema }>;
}

export interface OpenApiRequestBody {
  required: boolean;
  content: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>>;

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, OpenApiPathItem>;
  [key: string]: unknown;
}

export interface BuildOpenApiOptions {
  /** Document title (info.title). Defaults to "Mockify Capture". */
  title?: string;
  /** Document version (info.version, the *API's* version — unrelated to
   * the `openapi: 3.1.0` spec-version field). Defaults to "0.0.0". */
  version?: string;
}

// ---------------------------------------------------------------------------
// Param schema inference (raw path/query strings — distinct from Shape,
// which is for parsed JSON body values)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PARAM_EXAMPLE_CAP = 5;

function inferParamSchema(rawValues: string[]): JsonSchema {
  const uniq = [...new Set(rawValues)];
  if (uniq.length === 0) return { type: 'string' };

  if (uniq.every((v) => /^-?\d+$/.test(v))) {
    return { type: 'integer', examples: uniq.slice(0, PARAM_EXAMPLE_CAP).map((v) => parseInt(v, 10)) };
  }
  if (uniq.every((v) => /^-?\d*\.\d+$/.test(v))) {
    return { type: 'number', examples: uniq.slice(0, PARAM_EXAMPLE_CAP).map(parseFloat) };
  }
  if (uniq.every((v) => v === 'true' || v === 'false')) {
    return { type: 'boolean' };
  }
  if (uniq.every((v) => UUID_RE.test(v))) {
    return { type: 'string', format: 'uuid', examples: uniq.slice(0, PARAM_EXAMPLE_CAP) };
  }
  return { type: 'string', examples: uniq.slice(0, PARAM_EXAMPLE_CAP) };
}

// ---------------------------------------------------------------------------
// Path templating: "{p2}" (positional, synthesize's internal name) -> a
// human-friendly OpenAPI parameter name derived from the preceding literal
// path segment (e.g. "/api/room/{p2}" -> "/api/room/{roomId}").
// ---------------------------------------------------------------------------

function singularize(noun: string): string {
  return noun.endsWith('s') && noun.length > 1 ? noun.slice(0, -1) : noun;
}

/** Map each template.paramNames entry (e.g. "p2") to the OpenAPI parameter
 * name used in the rendered path and `parameters` array, deduping any
 * collisions (rare — e.g. two adjacent variables with no literal noun
 * between them) by falling back to the original positional name. */
function friendlyParamNames(template: EndpointTemplate): Map<string, string> {
  const segs = template.pathTemplate.split('/').filter(Boolean);
  const used = new Set<string>();
  const map = new Map<string, string>();

  for (const paramName of template.paramNames) {
    const pos = Number(paramName.slice(1));
    const preceding = pos > 0 ? segs[pos - 1] : undefined;
    let friendly = paramName;
    if (preceding && !/^\{.*\}$/.test(preceding)) {
      const noun = preceding.replace(/[^a-zA-Z0-9]/g, '');
      if (noun.length > 0) friendly = `${singularize(noun)}Id`;
    }
    if (used.has(friendly)) friendly = paramName; // fall back to the unambiguous positional name
    used.add(friendly);
    map.set(paramName, friendly);
  }
  return map;
}

function renderPathTemplate(template: EndpointTemplate, names: Map<string, string>): string {
  let out = template.pathTemplate;
  for (const paramName of template.paramNames) {
    out = out.replace(`{${paramName}}`, `{${names.get(paramName) ?? paramName}}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query parameters — observed across a template group's request URLs
// ---------------------------------------------------------------------------

interface QueryParamObservation {
  values: string[];
  presentCount: number;
}

function collectQueryParams(entries: CapturedTraffic[]): OpenApiParameter[] {
  const byName = new Map<string, QueryParamObservation>();

  for (const entry of entries) {
    let search: URLSearchParams;
    try {
      search = new URL(entry.url).searchParams;
    } catch {
      continue;
    }
    const seenInThisEntry = new Set<string>();
    for (const [key, value] of search.entries()) {
      if (!byName.has(key)) byName.set(key, { values: [], presentCount: 0 });
      const obs = byName.get(key)!;
      obs.values.push(value);
      if (!seenInThisEntry.has(key)) {
        obs.presentCount++;
        seenInThisEntry.add(key);
      }
    }
  }

  const total = entries.length;
  return [...byName.entries()].map(([name, obs]) => ({
    name,
    in: 'query' as const,
    required: obs.presentCount === total && total > 0,
    schema: inferParamSchema(obs.values),
  }));
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

function guessRequestContentType(entry: CapturedTraffic, postData: string): string {
  const fromHeader = entry.requestHeaders?.['content-type'];
  if (fromHeader) return fromHeader.split(';')[0].trim();
  try {
    JSON.parse(postData);
    return 'application/json';
  } catch {
    // fallthrough
  }
  if (/^[^=&]+=[^&]*(&[^=&]+=[^&]*)*$/.test(postData)) return 'application/x-www-form-urlencoded';
  return 'text/plain';
}

function formUrlEncodedSchema(bodies: string[]): JsonSchema {
  const perBody = bodies.map((b) => Object.fromEntries(new URLSearchParams(b).entries()));
  const allKeys = new Set<string>();
  for (const o of perBody) for (const k of Object.keys(o)) allKeys.add(k);

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const key of allKeys) {
    const present = perBody.filter((o) => Object.prototype.hasOwnProperty.call(o, key));
    properties[key] = { type: 'string', examples: [...new Set(present.map((o) => o[key]))].slice(0, PARAM_EXAMPLE_CAP) };
    if (present.length === perBody.length) required.push(key);
  }
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function buildRequestBody(entries: CapturedTraffic[]): OpenApiRequestBody | undefined {
  const withBody = entries.filter((e): e is CapturedTraffic & { postData: string } => !!e.postData);
  if (withBody.length === 0) return undefined;

  const byContentType = new Map<string, string[]>();
  for (const entry of withBody) {
    const ct = guessRequestContentType(entry, entry.postData);
    const arr = byContentType.get(ct);
    if (arr) arr.push(entry.postData);
    else byContentType.set(ct, [entry.postData]);
  }

  const content: Record<string, OpenApiMediaType> = {};
  for (const [contentType, bodies] of byContentType) {
    let schema: JsonSchema;
    if (contentType === 'application/json') {
      schema = shapeToJsonSchema(inferShape(bodies));
    } else if (contentType === 'application/x-www-form-urlencoded') {
      schema = formUrlEncodedSchema(bodies);
    } else {
      schema = { type: 'string' };
    }
    content[contentType] = { schema };
  }

  return { required: true, content };
}

// ---------------------------------------------------------------------------
// Responses — one per distinct observed status code (not just the modal
// status EndpointTemplate.status picks for synthesis)
// ---------------------------------------------------------------------------

const STATUS_REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function statusDescription(status: number): string {
  return STATUS_REASONS[status] ?? `HTTP ${status}`;
}

function modal<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** Response headers observed on every entry in this status group, excluding
 * hop-by-hop framing headers (format/headers.ts) and Content-Type (already
 * represented by the response's `content` media-type key). Optional by
 * design — a header only shows up if it was actually recorded (format
 * version 2+, see format/types.ts) and consistently present. */
function buildResponseHeaders(entries: CapturedTraffic[]): Record<string, { schema: JsonSchema }> | undefined {
  const withHeaders = entries.filter((e) => e.responseHeaders);
  if (withHeaders.length === 0) return undefined;

  const allNames = new Set<string>();
  for (const e of withHeaders) for (const name of Object.keys(e.responseHeaders!)) allNames.add(name);

  const headers: Record<string, { schema: JsonSchema }> = {};
  for (const name of allNames) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower) || lower === 'content-type') continue;
    const present = withHeaders.filter((e) => Object.prototype.hasOwnProperty.call(e.responseHeaders!, name));
    if (present.length !== entries.length) continue; // only document headers seen on every response in this group
    headers[name] = { schema: { type: 'string' } };
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function buildResponses(entries: CapturedTraffic[]): Record<string, OpenApiResponse> {
  const byStatus = new Map<number, CapturedTraffic[]>();
  for (const e of entries) {
    const arr = byStatus.get(e.status);
    if (arr) arr.push(e);
    else byStatus.set(e.status, [e]);
  }

  const responses: Record<string, OpenApiResponse> = {};
  for (const [status, statusEntries] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    const bodies = statusEntries.map((e) => e.responseBody ?? '').filter((b) => b !== '');
    const contentType = modal(statusEntries.map((e) => e.contentType || ''));
    const response: OpenApiResponse = { description: statusDescription(status) };

    if (bodies.length > 0) {
      const baseType = contentType.split(';')[0].trim();
      if (baseType.includes('json')) {
        response.content = { [contentType || 'application/json']: { schema: shapeToJsonSchema(inferShape(bodies)) } };
      } else {
        response.content = { [contentType || 'text/plain']: { schema: { type: 'string' } } };
      }
    }

    const headers = buildResponseHeaders(statusEntries);
    if (headers) response.headers = headers;

    responses[String(status)] = response;
  }
  return responses;
}

// ---------------------------------------------------------------------------
// Operation / path item assembly
// ---------------------------------------------------------------------------

function sanitizeForOperationId(s: string): string {
  return s
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildOperation(
  template: EndpointTemplate,
  entries: CapturedTraffic[],
  renderedPath: string,
  pathParams: OpenApiParameter[]
): OpenApiOperation {
  const queryParams = collectQueryParams(entries);
  const operation: OpenApiOperation = {
    operationId: sanitizeForOperationId(`${template.method.toLowerCase()}_${renderedPath}`),
    summary: `${template.method} ${renderedPath}`,
    responses: buildResponses(entries),
  };

  const parameters = [...pathParams, ...queryParams];
  if (parameters.length > 0) operation.parameters = parameters;

  const requestBody = buildRequestBody(entries);
  if (requestBody) operation.requestBody = requestBody;

  return operation;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function inferServers(entries: CapturedTraffic[]): Array<{ url: string }> | undefined {
  const origins = new Map<string, number>();
  for (const e of entries) {
    try {
      const origin = new URL(e.url).origin;
      origins.set(origin, (origins.get(origin) ?? 0) + 1);
    } catch {
      // ignore unparseable URLs
    }
  }
  if (origins.size === 0) return undefined;
  return [...origins.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => ({ url }));
}

/** Build an OpenAPI 3.1 document from a capture's traffic entries. Re-runs
 * synthesize/templates.ts's template inference (the same grouping
 * generateSynthetic() uses) rather than requiring synthetic/index.json to
 * already exist — `mockify spec` works directly off traffic.json. */
export function buildOpenApiDocument(entries: CapturedTraffic[], options: BuildOpenApiOptions = {}): OpenApiDocument {
  const groups = inferTemplateGroups(entries);

  const paths: Record<string, OpenApiPathItem> = {};
  for (const { template, entries: groupEntries } of groups) {
    const names = friendlyParamNames(template);
    const renderedPath = renderPathTemplate(template, names);
    const pathParams: OpenApiParameter[] = template.paramNames.map((paramName) => ({
      name: names.get(paramName) ?? paramName,
      in: 'path' as const,
      required: true,
      schema: inferParamSchema(template.observedValues[paramName] ?? []),
    }));

    const method = template.method.toLowerCase() as HttpMethod;
    if (!HTTP_METHODS.includes(method)) continue; // e.g. a nonstandard verb — skip rather than emit an invalid operation key

    const pathItem = paths[renderedPath] ?? {};
    pathItem[method] = buildOperation(template, groupEntries, renderedPath, pathParams);
    paths[renderedPath] = pathItem;
  }

  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'Mockify Capture',
      version: options.version ?? '0.0.0',
    },
    paths,
  };

  const servers = inferServers(entries);
  if (servers) doc.servers = servers;

  return doc;
}
