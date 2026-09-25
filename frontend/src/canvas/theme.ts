/**
 * Design tokens (index.css → @theme) for code that can't use CSS variables
 * directly — Pixi needs concrete colours. Read once from the stylesheet so
 * there is a single source of truth for chrome colours.
 */
export function themeColor(token: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || fallback;
}
