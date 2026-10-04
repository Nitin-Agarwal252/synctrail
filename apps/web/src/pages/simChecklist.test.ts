import { describe, it, expect } from 'vitest';
import { runSimulation, lastWriteWinsApply } from '@synctrail/shared';
import { checklistRows, checklistSummary } from './simChecklist';

describe('Chaos page checklist view (fix-R3)', () => {
  it('shows 7 green rows and the measured time for the real merge', () => {
    const result = runSimulation({ seeds: 20, steps: 300, devices: 3 });
    const rows = checklistRows(result);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.pass && r.label === 'Pass')).toBe(true);
    const summary = checklistSummary(result);
    expect(summary.tone).toBe('pass');
    expect(summary.text).toMatch(/^All 7 invariants hold across 20 seeds · \d+ ms measured$/);
  });

  it('shows red rows and the failing seed when merge is broken', () => {
    const result = runSimulation({ seeds: 20, steps: 300, devices: 3, apply: lastWriteWinsApply });
    const rows = checklistRows(result);
    expect(rows.some((r) => !r.pass && r.label === 'Fail')).toBe(true);
    const summary = checklistSummary(result);
    expect(summary.tone).toBe('fail');
    expect(summary.text).toContain(`first failing seed ${result.failingSeed}`);
  });
});
