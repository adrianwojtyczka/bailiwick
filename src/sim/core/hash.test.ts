import { describe, expect, it } from 'vitest';
import { Hasher } from './hash';

describe('Hasher', () => {
  it('is stable for identical input', () => {
    const a = new Hasher().int32(42).string('woodcutter').boolean(true).value();
    const b = new Hasher().int32(42).string('woodcutter').boolean(true).value();
    expect(a).toBe(b);
  });

  it('separates different input', () => {
    const a = new Hasher().int32(42).value();
    const b = new Hasher().int32(43).value();
    expect(a).not.toBe(b);
  });

  it('is order sensitive', () => {
    const a = new Hasher().int32(1).int32(2).value();
    const b = new Hasher().int32(2).int32(1).value();
    expect(a).not.toBe(b);
  });

  it('distinguishes arrays of differing length with the same prefix', () => {
    const a = new Hasher().array([1, 2, 3]).value();
    const b = new Hasher().array([1, 2, 3, 0]).value();
    expect(a).not.toBe(b);
  });

  it('hashes typed arrays the same as plain arrays', () => {
    const a = new Hasher().array(new Int32Array([4, 5, 6])).value();
    const b = new Hasher().array([4, 5, 6]).value();
    expect(a).toBe(b);
  });

  it('distinguishes floats that share an integer part', () => {
    const a = new Hasher().float64(1.5).value();
    const b = new Hasher().float64(1.25).value();
    expect(a).not.toBe(b);
  });

  it('renders eight hex characters', () => {
    expect(new Hasher().int32(0).hex()).toMatch(/^[0-9a-f]{8}$/);
  });
});
