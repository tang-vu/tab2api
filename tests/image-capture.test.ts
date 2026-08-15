import { describe, expect, it } from 'vitest';
import { validateIntrinsicPng } from '../src/adapters/chatgpt/adapter.js';

function pngHeader(width: number, height: number, length = 24): Buffer {
  const data = Buffer.alloc(length);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

describe('intrinsic image capture validation', () => {
  it('accepts a PNG with the expected intrinsic dimensions', () => {
    const data = pngHeader(1024, 768);
    expect(validateIntrinsicPng(data, { width: 1024, height: 768 }, 1024)).toBe(data);
  });

  it('rejects invalid signatures, dimension drift, and oversized captures', () => {
    expect(() => validateIntrinsicPng(Buffer.alloc(24), { width: 1, height: 1 }, 1024)).toThrow(
      'could not be captured safely',
    );
    expect(() =>
      validateIntrinsicPng(pngHeader(2048, 1024), { width: 1024, height: 1024 }, 1024),
    ).toThrow('could not be captured safely');
    expect(() => validateIntrinsicPng(pngHeader(1, 1, 25), { width: 1, height: 1 }, 24)).toThrow(
      'could not be captured safely',
    );
  });
});
