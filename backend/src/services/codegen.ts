import { getOpenApiSpec } from "./openapi.js";

/**
 * SDK code-snippet generator (#943).
 *
 * Turns a `{ route, method, params, language }` request into a ready-to-run
 * curl command or fetch-based TypeScript snippet for calling that route. The
 * OpenAPI document produced by {@link getOpenApiSpec} is the only template
 * source: path/query parameters, request bodies and the "requires API key"
 * note all come from the spec, so a snippet can never describe a route the API
 * does not actually serve.
 */

export type SnippetLanguage = "typescript" | "curl";

export interface CodegenInput {
  route: string;
  method: string;
  params?: Record<string, unknown>;
  language: SnippetLanguage;
  /** Absolute base URL snippets should call, e.g. `https://api.example.com`. */
  baseUrl: string;
}

export interface CodegenResult {
  language: SnippetLanguage;
  method: string;
  /** The resolved request URL, with path parameters substituted. */
  url: string;
  snippet: string;
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<
      string,
      {
        example?: unknown;
        examples?: Record<string, { value?: unknown }>;
        schema?: unknown;
      }
    >;
  };
  security?: unknown[];
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const API_KEY_ENV = "STELLARYIELD_API_KEY";

/** Drop any query string or fragment, force a single leading slash, collapse
 * repeated slashes and drop a trailing one. Mirrors the dry-run validator so
 * the two endpoints accept routes written the same way. */
export function normalizeRoute(route: string): string {
  const withoutQuery = route.split(/[?#]/)[0].trim();
  const collapsed = `/${withoutQuery}`.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** `/api/v1/vaults/{contractId}` and `/api/v1/vaults/:contractId` both become
 * `/api/v1/vaults/{contractId}` so a caller can use either convention. */
function canonicalTemplate(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function segmentsMatch(templatePath: string, requestedPath: string): boolean {
  const t = templatePath.split("/");
  const r = requestedPath.split("/");
  if (t.length !== r.length) return false;
  return t.every((seg, i) =>
    seg.startsWith("{") && seg.endsWith("}") ? r[i].length > 0 : seg === r[i],
  );
}

interface MatchedRoute {
  templatePath: string;
  method: string;
  operation: OpenApiOperation;
}

/** Locate the spec entry for `method`/`route`, or null when the API serves no
 * such route. Matching is exact first, then by path-parameter pattern. */
export function findRoute(method: string, route: string): MatchedRoute | null {
  const wantedMethod = method.trim().toUpperCase();
  const wantedRoute = canonicalTemplate(normalizeRoute(route));
  const spec = getOpenApiSpec();
  const paths = (spec.paths ?? {}) as Record<string, Record<string, OpenApiOperation>>;

  const entries = Object.entries(paths);
  const exact = entries.find(([p]) => p === wantedRoute);
  const matched =
    exact ?? entries.find(([p]) => segmentsMatch(p, wantedRoute)) ?? null;
  if (!matched) return null;

  const [templatePath, operations] = matched;
  const opKey = Object.keys(operations).find((k) => k.toUpperCase() === wantedMethod);
  if (!opKey) return null;

  return { templatePath, method: wantedMethod, operation: operations[opKey] };
}

function pathParamNames(templatePath: string): string[] {
  return [...templatePath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/** True when the spec marks the operation as needing credentials — either a
 * non-empty `security` requirement or a "(requires API key)" note in its
 * summary or description, which is how the StellarYield spec documents it. */
function requiresApiKey(operation: OpenApiOperation): boolean {
  if (Array.isArray(operation.security) && operation.security.length > 0) return true;
  const text = `${operation.summary ?? ""} ${operation.description ?? ""}`;
  return /requires\s+(?:an?\s+)?(?:admin\s+)?api key/i.test(text);
}

function exampleBody(operation: OpenApiOperation): unknown {
  const json = operation.requestBody?.content?.["application/json"];
  if (!json) return undefined;
  if (json.example !== undefined) return json.example;
  const firstNamed = json.examples && Object.values(json.examples)[0];
  if (firstNamed && "value" in firstNamed) return firstNamed.value;
  return undefined;
}

interface ResolvedRequest {
  url: string;
  requiresAuth: boolean;
  hasBody: boolean;
  body: unknown;
}

function resolveRequest(match: MatchedRoute, input: CodegenInput): ResolvedRequest {
  const params = input.params ?? {};
  const consumed = new Set<string>();

  let path = match.templatePath;
  for (const name of pathParamNames(match.templatePath)) {
    consumed.add(name);
    const value = params[name];
    const rendered =
      value === undefined || value === null
        ? `:${name}`
        : encodeURIComponent(String(value));
    path = path.replace(`{${name}}`, rendered);
  }

  const declaredQuery = (match.operation.parameters ?? [])
    .filter((p) => p.in === "query")
    .map((p) => p.name);

  const wantsBody = BODY_METHODS.has(match.method) && match.operation.requestBody !== undefined;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (consumed.has(key)) continue;
    if (value === undefined || value === null) continue;
    // Everything not in the path is a query parameter, unless the route takes a
    // body — then leftover params are the body instead.
    if (wantsBody) continue;
    if (declaredQuery.length > 0 && !declaredQuery.includes(key)) continue;
    search.set(key, String(value));
  }

  const bodyParams = Object.fromEntries(
    Object.entries(params).filter(([key]) => !consumed.has(key)),
  );
  const body = wantsBody
    ? Object.keys(bodyParams).length > 0
      ? bodyParams
      : (exampleBody(match.operation) ?? {})
    : undefined;

  const qs = search.toString();
  const url = `${input.baseUrl.replace(/\/+$/, "")}${path}${qs ? `?${qs}` : ""}`;

  return { url, requiresAuth: requiresApiKey(match.operation), hasBody: wantsBody, body };
}

function curlSnippet(method: string, req: ResolvedRequest): string {
  const lines: string[] = [`curl -X ${method} '${req.url}'`];
  if (req.hasBody) lines.push(`  -H 'Content-Type: application/json'`);
  if (req.requiresAuth) lines.push(`  -H "Authorization: Bearer $${API_KEY_ENV}"`);
  if (req.hasBody) {
    lines.push(`  -d '${JSON.stringify(req.body)}'`);
  }
  return lines.join(" \\\n");
}

function typescriptSnippet(method: string, req: ResolvedRequest): string {
  const headerEntries: string[] = [];
  if (req.hasBody) headerEntries.push(`    "Content-Type": "application/json",`);
  if (req.requiresAuth) {
    headerEntries.push(`    "Authorization": \`Bearer \${process.env.${API_KEY_ENV}}\`,`);
  }

  const init: string[] = [`  method: ${JSON.stringify(method)},`];
  if (headerEntries.length > 0) {
    init.push(`  headers: {\n${headerEntries.join("\n")}\n  },`);
  }
  if (req.hasBody) {
    init.push(`  body: JSON.stringify(${JSON.stringify(req.body, null, 2).replace(/\n/g, "\n  ")}),`);
  }

  return [
    `const response = await fetch(${JSON.stringify(req.url)}, {`,
    ...init,
    `});`,
    ``,
    `if (!response.ok) {`,
    `  throw new Error(\`Request failed with \${response.status}\`);`,
    `}`,
    ``,
    `const data = await response.json();`,
  ].join("\n");
}

/** Build a snippet for `input`, or null when the route/method pair is unknown. */
export function generateSnippet(input: CodegenInput): CodegenResult | null {
  const match = findRoute(input.method, input.route);
  if (!match) return null;

  const req = resolveRequest(match, input);
  const snippet =
    input.language === "curl"
      ? curlSnippet(match.method, req)
      : typescriptSnippet(match.method, req);

  return { language: input.language, method: match.method, url: req.url, snippet };
}
