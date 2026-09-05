/** DOM-safe anchor id for an attention item (item ids contain ':' / '|'), so a
 *  deep-link can land on the exact card. Client-safe — no imports. */
export function anchorFor(id: string): string {
  return "i-" + String(id).replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
}
