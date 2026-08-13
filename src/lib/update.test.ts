import { describe, expect, it } from 'vitest';
import { summarise } from './update';

describe('summarise', () => {
  it('is empty when there are no release notes', () => {
    expect(summarise(undefined)).toBe('');
    expect(summarise('')).toBe('');
    expect(summarise('   \n  ')).toBe('');
  });

  it('keeps only the first line', () => {
    expect(summarise('Fixes the chart\n\n- detail\n- detail')).toBe('Fixes the chart');
  });

  it('truncates a long line with an ellipsis', () => {
    const out = summarise('x'.repeat(200), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a line that already fits alone', () => {
    expect(summarise('Short note', 20)).toBe('Short note');
  });
});
