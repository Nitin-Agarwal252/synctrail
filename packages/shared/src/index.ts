export * from './types.ts';
export * as hlc from './hlc.ts';
export {
  applyOp,
  applyOptimistic,
  createServerState,
  previewOps,
  resolveConflict,
  seenOf,
} from './merge.ts';
export type { Resolver } from './merge.ts';
export { runSimulation, compareWithLastWriteWins, INVARIANTS } from './sim.ts';
export type {
  ApplyFn,
  InvariantResult,
  LostEditTotals,
  LwwComparison,
  SimulationCounts,
  SimulationOptions,
  SimulationResult,
} from './sim.ts';
export { lastWriteWinsApply } from './lwwHarness.ts';
