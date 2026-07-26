/**
 * Index allocator for the simulation's entity tables.
 *
 * Entities (buildings, flags, settlers, wares in transit) are stored as
 * parallel typed arrays — structure of arrays — rather than as objects. That
 * keeps the per-tick hot loops free of allocation and garbage, which matters a
 * great deal on a phone, and makes saving a matter of copying buffers.
 *
 * This class owns the "which slots are in use" bookkeeping for one such table.
 * Index 0 is permanently reserved to mean "none", so a zeroed array reads as
 * empty and no entity can be confused with absence.
 *
 * Iteration is always in ascending index order so that the simulation's
 * behaviour — and therefore its state hash — never depends on allocation
 * history.
 */
export class EntityPool {
  private aliveFlags: Uint8Array;
  private freeList: number[] = [];
  private highWater = 1;
  private growHandlers: ((capacity: number) => void)[] = [];

  capacity: number;
  count = 0;

  constructor(initialCapacity = 256) {
    this.capacity = Math.max(2, initialCapacity);
    this.aliveFlags = new Uint8Array(this.capacity);
  }

  /**
   * Registers a callback invoked when the pool grows, so the owning table can
   * resize its parallel arrays. Handlers run before the new index is handed out.
   */
  onGrow(handler: (capacity: number) => void): void {
    this.growHandlers.push(handler);
  }

  allocate(): number {
    // Reuse a freed slot before extending the table. The free list is saved
    // verbatim, so a restored game reuses slots in exactly the same order a
    // continuously running one would.
    const recycled = this.freeList.pop();
    if (recycled !== undefined) {
      this.aliveFlags[recycled] = 1;
      this.count += 1;
      return recycled;
    }

    if (this.highWater >= this.capacity) {
      this.grow(this.capacity * 2);
    }

    const id = this.highWater;
    this.highWater += 1;
    this.aliveFlags[id] = 1;
    this.count += 1;
    return id;
  }

  release(id: number): void {
    if (id <= 0 || id >= this.capacity || this.aliveFlags[id] === 0) return;
    this.aliveFlags[id] = 0;
    this.freeList.push(id);
    this.count -= 1;
  }

  isAlive(id: number): boolean {
    return id > 0 && id < this.capacity && this.aliveFlags[id] === 1;
  }

  /** Visits every live index in ascending order. */
  forEach(visit: (id: number) => void): void {
    for (let id = 1; id < this.highWater; id += 1) {
      if (this.aliveFlags[id] === 1) visit(id);
    }
  }

  /** Every live index, ascending. Allocates — avoid in per-tick code. */
  ids(): number[] {
    const result: number[] = [];
    for (let id = 1; id < this.highWater; id += 1) {
      if (this.aliveFlags[id] === 1) result.push(id);
    }
    return result;
  }

  /** One past the highest index ever allocated — the bound for `forEach`. */
  get limit(): number {
    return this.highWater;
  }

  private grow(capacity: number): void {
    const next = new Uint8Array(capacity);
    next.set(this.aliveFlags);
    this.aliveFlags = next;
    this.capacity = capacity;
    for (const handler of this.growHandlers) handler(capacity);
  }

  /** Ensures the pool can hold at least `capacity` entities. */
  reserve(capacity: number): void {
    if (capacity > this.capacity) this.grow(capacity);
  }

  save(): PoolSnapshot {
    return {
      capacity: this.capacity,
      highWater: this.highWater,
      alive: Array.from(this.aliveFlags.subarray(0, this.highWater)),
      freeList: [...this.freeList],
    };
  }

  static restore(snapshot: PoolSnapshot): EntityPool {
    const pool = new EntityPool(snapshot.capacity);
    pool.highWater = snapshot.highWater;
    pool.count = 0;
    for (let id = 1; id < snapshot.highWater; id += 1) {
      if (snapshot.alive[id] === 1) {
        pool.aliveFlags[id] = 1;
        pool.count += 1;
      }
    }
    pool.freeList = [...snapshot.freeList];
    return pool;
  }
}

export interface PoolSnapshot {
  readonly capacity: number;
  readonly highWater: number;
  readonly alive: readonly number[];
  readonly freeList: readonly number[];
}
