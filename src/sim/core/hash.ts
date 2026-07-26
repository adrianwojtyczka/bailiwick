/**
 * FNV-1a hashing, used to fingerprint simulation state.
 *
 * The golden determinism tests hash the whole world after a fixed number of
 * ticks and compare against a recorded constant, so any accidental
 * non-determinism (iteration order, uninitialised memory, a stray `Math.random`)
 * shows up as a failing test rather than as a corrupted save months later.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export class Hasher {
  private hash = FNV_OFFSET_BASIS;

  byte(value: number): this {
    this.hash = Math.imul(this.hash ^ (value & 0xff), FNV_PRIME) >>> 0;
    return this;
  }

  /** Mixes in a 32-bit integer, least significant byte first. */
  int32(value: number): this {
    const v = value | 0;
    return this.byte(v).byte(v >>> 8).byte(v >>> 16).byte(v >>> 24);
  }

  /** Mixes in a float by hashing its exact IEEE-754 bit pattern. */
  float64(value: number): this {
    FLOAT_VIEW.setFloat64(0, value);
    for (let i = 0; i < 8; i += 1) this.byte(FLOAT_VIEW.getUint8(i));
    return this;
  }

  string(value: string): this {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      this.byte(code).byte(code >>> 8);
    }
    return this;
  }

  boolean(value: boolean): this {
    return this.byte(value ? 1 : 0);
  }

  /** Mixes in a typed array's contents element by element. */
  array(values: ArrayLike<number>): this {
    this.int32(values.length);
    for (let i = 0; i < values.length; i += 1) this.int32(values[i]!);
    return this;
  }

  /** The digest as an unsigned 32-bit integer. */
  value(): number {
    return this.hash >>> 0;
  }

  /** The digest as a zero-padded 8-character hex string. */
  hex(): string {
    return this.value().toString(16).padStart(8, '0');
  }
}

const FLOAT_VIEW = new DataView(new ArrayBuffer(8));
