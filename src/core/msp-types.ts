/** Data-only subset of Malody V modules. No imported script is evaluated. */
export interface MSPSprite {
  image: string;
  flipX?: boolean;
  additive?: boolean;
}
export interface MSPAnimation {
  frames: string[];
  fps: number;
  additive?: boolean;
}
export interface MSPPresentation {
  profile?: 'rm-white-blue';
  trackLeft?: MSPSprite;
  trackLight?: MSPSprite;
  trackBottom?: MSPSprite;
  keyBackground?: MSPSprite;
  laneLine?: MSPSprite;
  press?: MSPSprite;
  hit?: MSPAnimation;
  holdHit?: MSPAnimation;
  perfectEffect?: MSPSprite;
  cat?: { background: string; presses: string[]; poses: string[] };
  /** Planar depth curve. Screen-space lane edges remain the same for input. */
  depth?: number;
}
