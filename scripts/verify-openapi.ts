/**
 * Re-runs `dump:openapi` into a temp file and diffs against the committed
 * artifact. Used by CI to ensure the OpenAPI contract stays in sync with
 * the live route schemas.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const tracked = resolve(here, "../../vibly-coordinator-http-contract/openapi.json");
const tmp = mkdtempSync(join(tmpdir(), "openapi-verify-"));
const candidate = join(tmp, "openapi.json");

try {
  execFileSync("tsx", [resolve(here, "dump-openapi.ts"), candidate], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  const expected = readFileSync(tracked, "utf8");
  const actual = readFileSync(candidate, "utf8");
  if (expected !== actual) {
    console.error(
      `[verify:openapi] Drift detected. Run \`pnpm --filter vibly-coordinator dump:openapi\` and commit the result.\nExpected: ${tracked}\nActual:   ${candidate}`,
    );
    process.exit(1);
  }
  console.log("[verify:openapi] In sync.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
