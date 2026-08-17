/**
 * Picks readable text (AC6, WCAG AA — 4.5:1 for body text) against a tenant's
 * own brand colour, which is arbitrary input the tenant chose and this page
 * doesn't control. Relative luminance per the WCAG formula; a hex the tenant
 * supplied that fails to parse falls back to black-on-white, the pairing the
 * rest of the page already uses.
 */
export function contrastingTextColor(hex: string | null | undefined): "#000000" | "#ffffff" {
  const rgb = parseHex(hex);
  if (!rgb) return "#000000";
  const luminance = relativeLuminance(rgb);
  // Luminance of white is 1, black is 0 — 0.5-ish is the usual crossover;
  // 0.179 is the WCAG-derived threshold where white text (contrast against
  // black background) starts beating black text on the same colour.
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

function parseHex(hex: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!hex) return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
