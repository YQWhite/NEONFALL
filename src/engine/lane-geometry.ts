export interface FieldOrigin {
  ox: number; oy: number; scale: number; scaleY: number;
  /** Actual viewport edges in logical field units. Optional for older callers. */
  top?: number; bottom?: number;
}

/** Input uses the same projected lane edges and independent X/Y scale as drawing. */
export function laneAtPoint(x: number, y: number, origin: FieldOrigin, start: number, widths: number[], projectX: (x: number, y: number) => number): number {
  const logicalY = (y - origin.oy) / origin.scaleY;
  const top = origin.top ?? 0, bottom = origin.bottom ?? 480;
  // Moving the hit line must not leave a dead band below the old 480px stage.
  // The lower 60% of the visible viewport remains available to touch input.
  if (logicalY < top + (bottom - top) * .4 || logicalY > bottom) return -1;
  const logicalX = (x - origin.ox) / origin.scale;
  let left = start;
  for (let col = 0; col < widths.length; col++) {
    const right = left + widths[col];
    if (logicalX >= projectX(left, logicalY) && logicalX < projectX(right, logicalY)) return col;
    left = right;
  }
  return -1;
}
