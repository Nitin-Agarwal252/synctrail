import type { SimulationResult } from '@synctrail/shared';

export interface ChecklistRow {
  name: string;
  pass: boolean;
  label: 'Pass' | 'Fail';
  detail: string;
}

export function checklistRows(result: SimulationResult): ChecklistRow[] {
  return result.invariants.map((inv) => ({
    name: inv.name,
    pass: inv.pass,
    label: inv.pass ? 'Pass' : 'Fail',
    detail: inv.detail,
  }));
}

export function checklistSummary(result: SimulationResult): { tone: 'pass' | 'fail'; text: string } {
  const ms = `${Math.round(result.elapsedMs)} ms measured`;
  const total = result.invariants.length;
  if (result.pass) {
    return { tone: 'pass', text: `All ${total} invariants hold across ${result.seeds} seeds · ${ms}` };
  }
  const broken = result.invariants.filter((i) => !i.pass).length;
  return {
    tone: 'fail',
    text: `${broken} of ${total} invariants broken · first failing seed ${result.failingSeed} · ${ms}`,
  };
}
