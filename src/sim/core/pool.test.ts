import { describe, expect, it } from 'vitest';
import { EntityPool } from './pool';

describe('EntityPool', () => {
  it('never hands out index zero', () => {
    const pool = new EntityPool(4);
    for (let i = 0; i < 10; i += 1) {
      expect(pool.allocate()).toBeGreaterThan(0);
    }
  });

  it('tracks liveness and count', () => {
    const pool = new EntityPool(4);
    const a = pool.allocate();
    const b = pool.allocate();

    expect(pool.count).toBe(2);
    expect(pool.isAlive(a)).toBe(true);

    pool.release(a);

    expect(pool.count).toBe(1);
    expect(pool.isAlive(a)).toBe(false);
    expect(pool.isAlive(b)).toBe(true);
  });

  it('recycles released indices', () => {
    const pool = new EntityPool(8);
    const a = pool.allocate();
    pool.allocate();
    pool.release(a);
    expect(pool.allocate()).toBe(a);
  });

  it('ignores releasing an index twice', () => {
    const pool = new EntityPool(4);
    const a = pool.allocate();
    pool.release(a);
    pool.release(a);
    expect(pool.count).toBe(0);
    expect(pool.allocate()).toBe(a);
    expect(pool.allocate()).not.toBe(a);
  });

  it('grows past its initial capacity and notifies listeners', () => {
    const pool = new EntityPool(2);
    const capacities: number[] = [];
    pool.onGrow((capacity) => capacities.push(capacity));

    const ids = Array.from({ length: 20 }, () => pool.allocate());

    expect(new Set(ids).size).toBe(20);
    expect(pool.capacity).toBeGreaterThanOrEqual(21);
    expect(capacities.length).toBeGreaterThan(0);
    for (const id of ids) expect(pool.isAlive(id)).toBe(true);
  });

  it('iterates live entities in ascending order', () => {
    const pool = new EntityPool(16);
    const ids = Array.from({ length: 6 }, () => pool.allocate());
    pool.release(ids[1]!);
    pool.release(ids[3]!);

    const visited: number[] = [];
    pool.forEach((id) => visited.push(id));

    expect(visited).toEqual([ids[0], ids[2], ids[4], ids[5]]);
    expect(pool.ids()).toEqual(visited);
  });

  it('restores an identical allocation sequence from a snapshot', () => {
    const pool = new EntityPool(8);
    const ids = Array.from({ length: 6 }, () => pool.allocate());
    pool.release(ids[4]!);
    pool.release(ids[1]!);

    const restored = EntityPool.restore(pool.save());

    expect(restored.count).toBe(pool.count);
    expect(restored.ids()).toEqual(pool.ids());
    // The free list order is part of the snapshot, so both pools must continue
    // handing out the same indices.
    expect(restored.allocate()).toBe(pool.allocate());
    expect(restored.allocate()).toBe(pool.allocate());
    expect(restored.allocate()).toBe(pool.allocate());
  });
});
