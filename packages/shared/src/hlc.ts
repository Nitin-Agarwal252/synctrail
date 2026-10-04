import type { Hlc } from './types.ts';

export interface HlcParts {
  wall: number;
  counter: number;
  node: string;
}

const WALL_PAD = 15;
const COUNTER_PAD = 5;

/** nodeId must not contain ':'. Use a UUID without separators or a short random id. */
export function format(p: HlcParts): Hlc {
  return `${String(p.wall).padStart(WALL_PAD, '0')}:${String(p.counter).padStart(COUNTER_PAD, '0')}:${p.node}`;
}

export function parse(h: Hlc): HlcParts {
  const [wall, counter, ...rest] = h.split(':');
  return { wall: Number(wall), counter: Number(counter), node: rest.join(':') };
}

/** Lexicographic compare is correct because wall and counter are zero-padded. */
export function compare(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function max(a: Hlc, b: Hlc): Hlc {
  return compare(a, b) >= 0 ? a : b;
}

/** Local event or send. `now` is injected so tests are deterministic. */
export function tick(prev: Hlc | null, node: string, now: number): Hlc {
  if (prev === null) return format({ wall: now, counter: 0, node });
  const p = parse(prev);
  const wall = Math.max(p.wall, now);
  const counter = wall === p.wall ? p.counter + 1 : 0;
  return format({ wall, counter, node });
}

/** Merge a remote timestamp into the local clock on receive. */
export function receive(prev: Hlc | null, remote: Hlc, node: string, now: number): Hlc {
  const r = parse(remote);
  const p = prev === null ? { wall: 0, counter: 0, node } : parse(prev);
  const wall = Math.max(p.wall, r.wall, now);
  let counter: number;
  if (wall === p.wall && wall === r.wall) counter = Math.max(p.counter, r.counter) + 1;
  else if (wall === p.wall) counter = p.counter + 1;
  else if (wall === r.wall) counter = r.counter + 1;
  else counter = 0;
  return format({ wall, counter, node });
}
