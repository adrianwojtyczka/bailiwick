import { EntityPool, type PoolSnapshot } from '../core/pool';

/**
 * A pool-indexed table of entities.
 *
 * Indices are stable for an entity's lifetime and are reused after it is
 * removed, so entity references elsewhere in the simulation are plain numbers.
 * Iteration is always in ascending index order, which keeps the simulation's
 * behaviour independent of the order things happened to be created in.
 */
export class EntityTable<T> {
  private pool: EntityPool;
  private readonly items: (T | undefined)[] = [];

  constructor(initialCapacity = 128, pool?: EntityPool) {
    this.pool = pool ?? new EntityPool(initialCapacity);
  }

  get count(): number {
    return this.pool.count;
  }

  /** Creates an entity, handing the factory the index it will live at. */
  add(create: (id: number) => T): T {
    const id = this.pool.allocate();
    const entity = create(id);
    this.items[id] = entity;
    return entity;
  }

  get(id: number): T | undefined {
    return this.pool.isAlive(id) ? this.items[id] : undefined;
  }

  /** Like `get`, but throws rather than returning undefined. */
  require(id: number): T {
    const entity = this.get(id);
    if (entity === undefined) throw new Error(`no such entity: ${id}`);
    return entity;
  }

  has(id: number): boolean {
    return this.pool.isAlive(id);
  }

  remove(id: number): void {
    if (!this.pool.isAlive(id)) return;
    this.pool.release(id);
    this.items[id] = undefined;
  }

  /** Visits every live entity in ascending index order. */
  forEach(visit: (entity: T, id: number) => void): void {
    this.pool.forEach((id) => {
      const entity = this.items[id];
      if (entity !== undefined) visit(entity, id);
    });
  }

  /**
   * Every live entity, ascending. Allocates a new array, so prefer `forEach`
   * inside the per-tick loops.
   */
  all(): T[] {
    const result: T[] = [];
    this.forEach((entity) => result.push(entity));
    return result;
  }

  /** The first entity matching a predicate, in ascending index order. */
  find(predicate: (entity: T) => boolean): T | undefined {
    let found: T | undefined;
    this.forEach((entity) => {
      if (found === undefined && predicate(entity)) found = entity;
    });
    return found;
  }

  ids(): number[] {
    return this.pool.ids();
  }

  savePool(): PoolSnapshot {
    return this.pool.save();
  }

  /**
   * Refills this table from a saved pool and the entities it held.
   *
   * Deliberately in place rather than returning a new table: the flag network
   * and the simulation hold references to these tables, and swapping the
   * objects out would leave those references pointing at the old, empty ones.
   */
  adopt(pool: PoolSnapshot, entities: readonly (T & { id: number })[]): void {
    this.pool = EntityPool.restore(pool);
    this.items.length = 0;
    for (const entity of entities) this.items[entity.id] = entity;
  }
}
