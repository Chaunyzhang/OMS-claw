export function normalizeQueryText(query: string): string {
  return query.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function tokenTerms(query: string, minLength = 2): string[] {
  return normalizeQueryText(query)
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .filter((term) => term.length >= minLength)
    .slice(0, 16);
}

export function ftsMatchQuery(query: string): string | undefined {
  const terms = tokenTerms(query, 2).slice(0, 12);
  if (terms.length === 0) {
    return undefined;
  }
  return terms.map((term) => `"${term.replace(/"/gu, "\"\"")}"`).join(" OR ");
}
