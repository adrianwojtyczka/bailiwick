/**
 * Seeded pseudo-random number generator (mulberry32).
 *
 * The simulation must be reproducible: the same seed and the same command log
 * must always yield the same world. `Math.random` is therefore banned inside
 * `src/sim` (enforced by an ESLint rule) and every random draw goes through an
 * instance of this class, whose entire state is one 32-bit integer and so
 * serialises into saves trivially.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Zero is a valid mulberry32 state but a dull one; nudge it off the origin.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Returns the next raw 32-bit unsigned integer. */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Returns a float in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  /** Returns an integer in [0, bound). Returns 0 when `bound` is not positive. */
  nextInt(bound: number): number {
    if (bound <= 0) return 0;
    return this.nextUint32() % bound;
  }

  /** Returns an integer in [min, max] inclusive. */
  nextRange(min: number, max: number): number {
    if (max <= min) return min;
    return min + this.nextInt(max - min + 1);
  }

  /** Returns true with the given probability in [0, 1]. */
  chance(probability: number): boolean {
    return this.nextFloat() < probability;
  }

  /** Picks a uniformly random element, or undefined for an empty array. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.nextInt(items.length)];
  }

  /** Fisher-Yates, in place, using only this generator's stream. */
  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const a = items[i]!;
      const b = items[j]!;
      items[i] = b;
      items[j] = a;
    }
  }

  /** The complete generator state, for saving. */
  save(): number {
    return this.state;
  }

  /** Restores a generator from `save()`. */
  static restore(state: number): Rng {
    const rng = new Rng(1);
    rng.state = state >>> 0;
    return rng;
  }
}
