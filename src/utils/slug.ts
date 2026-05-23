/**
 * Stable slug generation for public Library read-models.
 *
 * Rules:
 * - Lowercase kebab-case derived from title.
 * - Non-ASCII characters are stripped (no transliteration dependency).
 * - Non-alphanumeric characters become hyphens; consecutive hyphens are collapsed.
 * - Leading/trailing hyphens are stripped.
 * - Empty result falls back to the id.
 * - Callers should persist the generated slug and NOT regenerate it on every update.
 *   Conflict resolution is handled externally by appending a short id suffix if needed.
 */

/**
 * Generate a URL-safe slug from `title`.
 * Falls back to `id` when the title produces an empty result.
 */
export function generateSlug(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // keep word chars, spaces, hyphens
    .replace(/[\s_]+/g, "-") // spaces/underscores → hyphens
    .replace(/-+/g, "-") // collapse consecutive hyphens
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens

  return base.length > 0 ? base : id;
}

/**
 * Append a short suffix from `id` to disambiguate a conflicting slug.
 * e.g. "open-intelligence" + "art_abc12345" → "open-intelligence-abc12345"
 */
export function withSuffix(slug: string, id: string): string {
  const suffix = id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return suffix.length > 0 ? `${slug}-${suffix}` : `${slug}-${id.slice(0, 8)}`;
}
