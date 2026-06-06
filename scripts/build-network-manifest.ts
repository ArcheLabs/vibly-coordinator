import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const defaultSourceCandidates = [
  "network-manifest.production.json",
  "templates/network-manifest.production.json.example",
];

const sourceFile = process.env.NETWORK_MANIFEST_SOURCE_FILE?.trim() || defaultSourceCandidates.find((candidate) => {
  try {
    readFileSync(resolve(candidate), "utf8");
    return true;
  } catch {
    return false;
  }
});
const outputFile = process.env.NETWORK_MANIFEST_OUT_FILE?.trim() || "dist/network-manifest.json";

if (!sourceFile) {
  throw new Error(`No network manifest source found. Tried: ${defaultSourceCandidates.join(", ")}`);
}

const inputPath = resolve(sourceFile);
const outputPath = resolve(outputFile);
const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;

if (!Array.isArray(parsed)) {
  throw new Error(`Network manifest source must be a JSON array: ${inputPath}`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(parsed)}\n`);
console.log(`[network-manifest] wrote ${outputFile} from ${sourceFile}`);
