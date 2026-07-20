/** Small text helpers shared across providers (ported from scraper.py). */

/** Strips HTML tags, unescapes entities and collapses whitespace. */
export function plainText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const withoutTags = value.replace(/<[^>]+>/g, " ");
  const unescaped = decodeHtmlEntities(withoutTags);
  return unescaped.replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  "#39": "'",
};

/** Minimal HTML entity decoder (named + numeric), mirroring html.unescape. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code)) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

/** Lower-cases, then replaces runs of non-alphanumerics with `separator`. */
export function slug(value: unknown, separator = "-"): string {
  const text = String(plainText(String(value ?? "")) ?? "").toLowerCase();
  const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`[^${escaped}a-z0-9]+`, "g");
  const replaced = text.replace(pattern, separator);
  // Trim leading/trailing separators.
  const sepEsc = escaped;
  return replaced
    .replace(new RegExp(`^(?:${sepEsc})+`), "")
    .replace(new RegExp(`(?:${sepEsc})+$`), "");
}

export function columnSlug(value: unknown): string {
  return slug(value, "_");
}
