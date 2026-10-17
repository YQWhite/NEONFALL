/** Input uses the same projected lane edges and independent X/Y scale as drawing. */
export function laneAtPoint(x: number, y: number, origin: { ox: number; oy: number; scale: number; scaleY: number }, start: number, widths: number[], projectX: (x: number, y: number) => number): number {
  const logicalY = (y - origin.oy) / origin.scaleY;
  if (logicalY < 480 * .4 || logicalY > 480) return -1;
  const logicalX = (x - origin.ox) / origin.scale;
  let left = start;
  for (let col = 0; col < widths.length; col++) {
    const right = left + widths[col];
    if (logicalX >= projectX(left, logicalY) && logicalX < projectX(right, logicalY)) return col;
    left = right;
  }
  return -1;
}
