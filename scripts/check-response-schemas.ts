/**
 * CI gate: walks `openapi.json` and reports any route whose 200 response
 * does not have a `schema.response` (= no `responses[200].content` in the
 * dumped OpenAPI). At Phase 4 the goal is 100% coverage; until then we
 * track the count and fail on regression beyond a configured threshold.
 *
 * Usage:
 *   pnpm --filter vibly-coordinator check:response-schemas
 *   pnpm --filter vibly-coordinator check:response-schemas --max-missing 30
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const openApi = JSON.parse(
  readFileSync(resolve(here, "../../vibly-coordinator-http-contract/openapi.json"), "utf8"),
) as {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>>;
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

const missing: string[] = [];
const total: string[] = [];
for (const [routePath, methods] of Object.entries(openApi.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!HTTP_METHODS.has(method)) continue;
    const id = `${method.toUpperCase()} ${routePath}`;
    total.push(id);
    const ok = op.responses?.["200"]?.content?.["application/json"];
    if (!ok) missing.push(id);
  }
}

const args = process.argv.slice(2);
const flagIdx = args.indexOf("--max-missing");
const maxMissing = flagIdx >= 0 ? Number(args[flagIdx + 1] ?? "0") : 200;

const coverage = total.length === 0 ? 1 : (total.length - missing.length) / total.length;
console.log(
  `[response-schema] ${total.length - missing.length}/${total.length} routes have schema.response (${(coverage * 100).toFixed(1)}%)`,
);

if (missing.length > maxMissing) {
  console.error(
    `[response-schema] ${missing.length} routes missing 200 response schema; threshold is ${maxMissing}.`,
  );
  for (const id of missing) console.error(` - ${id}`);
  process.exit(1);
}

if (missing.length > 0) {
  console.warn(`[response-schema] ${missing.length} routes still missing schema.response (under threshold ${maxMissing}).`);
}
