import { describe, expect, it } from 'vitest';
import { Rng } from './rng';

describe('Rng', () => {
  it('produces the same stream for the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 100; i += 1) {
      expect(a.nextUint32()).toBe(b.nextUint32());
    }
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const drawsA = Array.from({ length: 20 }, () => a.nextUint32());
    const drawsB = Array.from({ length: 20 }, () => b.nextUint32());
    expect(drawsA).not.toEqual(drawsB);
  });

  it('keeps floats within [0, 1)', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps integers within bounds', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.nextInt(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
  });

  it('treats nextRange as inclusive at both ends', () => {
    const rng = new Rng(4242);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) seen.add(rng.nextRange(3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('resumes an identical stream after save and restore', () => {
    const original = new Rng(2024);
    for (let i = 0; i < 17; i += 1) original.nextUint32();

    const resumed = Rng.restore(original.save());

    for (let i = 0; i < 50; i += 1) {
      expect(resumed.nextUint32()).toBe(original.nextUint32());
    }
  });

  it('shuffles deterministically', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const b = [1, 2, 3, 4, 5, 6, 7, 8];
    new Rng(555).shuffle(a);
    new Rng(555).shuffle(b);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('never returns zero state for a zero seed', () => {
    const rng = new Rng(0);
    const draws = new Set(Array.from({ length: 10 }, () => rng.nextUint32()));
    expect(draws.size).toBeGreaterThan(1);
  });
});
