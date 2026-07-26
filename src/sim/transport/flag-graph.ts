import type { EntityTable } from '../entities/registry';
import type { Flag, Road } from '../entities/types';

/** One hop of a journey through the road network. */
export interface RouteStep {
  /** The flag to move to next. */
  readonly nextFlag: number;
  /** The road to travel along. */
  readonly road: number;
  /** Total remaining cost to the destination. */
  readonly cost: number;
}

interface SearchResult {
  /** Cost from the search origin to every reachable flag. */
  readonly cost: Map<number, number>;
  /** For each flag, the hop that leads back towards the origin. */
  readonly towardsOrigin: Map<number, RouteStep>;
}

/** Binary min-heap over (flag, cost) pairs. */
class FlagHeap {
  private readonly flags: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.flags.length;
  }

  push(flag: number, cost: number): void {
    this.flags.push(flag);
    this.costs.push(cost);

    let child = this.flags.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.costs[parent]! <= this.costs[child]!) break;
      this.swap(parent, child);
      child = parent;
    }
  }

  pop(): { flag: number; cost: number } | undefined {
    if (this.flags.length === 0) return undefined;

    const flag = this.flags[0]!;
    const cost = this.costs[0]!;

    const lastFlag = this.flags.pop()!;
    const lastCost = this.costs.pop()!;

    if (this.flags.length > 0) {
      this.flags[0] = lastFlag;
      this.costs[0] = lastCost;

      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < this.flags.length && this.costs[left]! < this.costs[smallest]!) smallest = left;
        if (right < this.flags.length && this.costs[right]! < this.costs[smallest]!) smallest = right;
        if (smallest === parent) break;
        this.swap(parent, smallest);
        parent = smallest;
      }
    }

    return { flag, cost };
  }

  private swap(a: number, b: number): void {
    const flag = this.flags[a]!;
    this.flags[a] = this.flags[b]!;
    this.flags[b] = flag;

    const cost = this.costs[a]!;
    this.costs[a] = this.costs[b]!;
    this.costs[b] = cost;
  }
}

/**
 * The road network seen as a graph: flags are nodes, roads are edges.
 *
 * Wares are not given a full route when they set out. Instead each flag knows
 * only the next hop towards the destination, which is what lets a carrier hand
 * a crate over and forget about it — and what lets the network re-route around
 * a road the player has just torn up.
 *
 * Searches are cached per flag and thrown away wholesale whenever the topology
 * changes. Roads are undirected, so a single search from a flag serves both as
 * "what does it cost to get there from here" and "which way do I send this".
 */
export class FlagNetwork {
  private readonly cache = new Map<number, SearchResult>();

  constructor(
    private readonly flags: EntityTable<Flag>,
    private readonly roads: EntityTable<Road>,
  ) {}

  /** Discards every cached search. Call whenever a road is laid or removed. */
  invalidate(): void {
    this.cache.clear();
  }

  /** The next hop from `from` towards `to`, or undefined if unreachable. */
  next(from: number, to: number): RouteStep | undefined {
    if (from === to) return undefined;
    return this.search(to).towardsOrigin.get(from);
  }

  /** Travel cost between two flags, or undefined if unreachable. */
  cost(from: number, to: number): number | undefined {
    if (from === to) return 0;
    return this.search(from).cost.get(to);
  }

  /** Cost from `origin` to every flag it can reach. */
  costsFrom(origin: number): ReadonlyMap<number, number> {
    return this.search(origin).cost;
  }

  /** True when a ware at `from` can eventually reach `to`. */
  reaches(from: number, to: number): boolean {
    return from === to || this.search(from).cost.has(to);
  }

  private search(origin: number): SearchResult {
    const cached = this.cache.get(origin);
    if (cached) return cached;

    const cost = new Map<number, number>();
    const towardsOrigin = new Map<number, RouteStep>();

    if (this.flags.has(origin)) {
      const heap = new FlagHeap();
      cost.set(origin, 0);
      heap.push(origin, 0);

      for (;;) {
        const entry = heap.pop();
        if (!entry) break;

        // Stale heap entry from a later, cheaper relaxation.
        const best = cost.get(entry.flag);
        if (best === undefined || entry.cost > best) continue;

        const flag = this.flags.get(entry.flag);
        if (!flag) continue;

        for (const roadId of flag.roads) {
          const road = this.roads.get(roadId);
          if (!road) continue;

          const other = road.fromFlag === entry.flag ? road.toFlag : road.fromFlag;
          if (!this.flags.has(other)) continue;

          const candidate = entry.cost + road.cost;
          const existing = cost.get(other);
          if (existing !== undefined && existing <= candidate) continue;

          cost.set(other, candidate);
          // From `other`, the way back to the origin starts along this road.
          towardsOrigin.set(other, { nextFlag: entry.flag, road: roadId, cost: candidate });
          heap.push(other, candidate);
        }
      }
    }

    const result: SearchResult = { cost, towardsOrigin };
    this.cache.set(origin, result);
    return result;
  }
}
