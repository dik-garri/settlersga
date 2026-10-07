/**
 * Our own pictograms for the side panel's gem buttons (inline SVG, 24×24 view box, drawn in the
 * current colour). Simple silhouettes, so they read at gem size on any background.
 */

const GLYPHS = {
  // A house gable with a hammer leaning on it.
  build:
    '<path d="M3 12 11 5l8 7v8H3z" fill="currentColor" opacity=".85"/><path d="M8 20v-5h4v5" fill="#000" opacity=".35"/>' +
    '<path d="m14 9 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="m17.5 6.5 3 3-2 2-3-3z" fill="currentColor"/>',
  // A tied sack.
  goods:
    '<path d="M8 6h8l-1.5 3c3 1.5 4.5 4.5 4.5 7.5 0 3-2.5 4.5-7 4.5s-7-1.5-7-4.5c0-3 1.5-6 4.5-7.5z" fill="currentColor"/>' +
    '<path d="M9 9h6" stroke="#000" stroke-opacity=".4" stroke-width="1.5"/>',
  // Two scale pans on a beam: who gets how much.
  distribution:
    '<path d="M12 4v15M6 19h12M5 8h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M2.5 13 5 8l2.5 5zM16.5 13 19 8l2.5 5z" fill="currentColor"/>',
  // A settler's head and shoulders.
  settlers:
    '<circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 21c0-5 3.5-8 8-8s8 3 8 8z" fill="currentColor"/>',
  // Three rising bars.
  stats: '<path d="M4 20h17" stroke="currentColor" stroke-width="2"/><rect x="5" y="12" width="4" height="8" fill="currentColor"/>' +
    '<rect x="10.5" y="7" width="4" height="13" fill="currentColor"/><rect x="16" y="3" width="4" height="17" fill="currentColor"/>',
  // A round shield with a sword across it.
  army:
    '<circle cx="11" cy="13" r="7" fill="currentColor"/><circle cx="11" cy="13" r="2.4" fill="#000" opacity=".35"/>' +
    '<path d="m6 3 13 13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="m16 18 4-4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  // A cog wheel.
  options:
    '<path d="M12 2.5l1.6 2.4 2.8-.8.6 2.9 2.8.9-.9 2.8 2 2.1-2 2.1.9 2.8-2.8.9-.6 2.9-2.8-.8L12 21.5l-1.6-2.4-2.8.8-.6-2.9-2.8-.9.9-2.8-2-2.1 2-2.1-.9-2.8 2.8-.9.6-2.9 2.8.8z" fill="currentColor"/>' +
    '<circle cx="12" cy="12" r="3.2" fill="#000" opacity=".45"/>',
  // Pause bars / play triangle.
  pause: '<rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/>',
  // Close cross.
  close: '<path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function glyph(name: GlyphName, size = 22): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = GLYPHS[name];
  return svg;
}
