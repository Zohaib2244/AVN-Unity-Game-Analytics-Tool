// The AVN Analytics mark, drawn inline so it follows the theme and palette: the tile is the page background, the
// frame is the accent and the glyph is the text colour. (The favicon follows the same colours; see public/theme.js.)
import type { ReactElement } from 'react';

export function BrandMark({ size = 28, className }: { size?: number; className?: string }): ReactElement {
  return (
    <svg className={`brand-mark${className ? ` ${className}` : ''}`} viewBox="0 0 10 10" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <rect className="bm-tile" width="10" height="10" />
      <path className="bm-frame" d="M2 1h5v1H2zM1 2h1v5H1zM7 2h1v5H7zM2 7h5v1H2zM8 1h1v1H8z" />
      <path className="bm-glyph" d="M3 5h1v2H3zM5 3h1v4H5z" />
    </svg>
  );
}
