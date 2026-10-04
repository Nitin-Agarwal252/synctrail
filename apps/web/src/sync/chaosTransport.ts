/**
 * ChaosTransport — wraps any SyncTransport with per-device network profiles.
 * Profile is stored in localStorage so it survives page reloads.
 * This is purely a client-side simulation layer; the server never knows.
 */

import { type SyncTransport, type PullResponse } from './engine';
import { type Op, type ApplyResult, type FieldValue } from '@synctrail/shared';

export type NetworkProfile = 'normal' | 'offline' | 'flaky' | 'slow' | 'partition';

const LS_KEY = 'synctrail_network_profile';

function loadProfile(): NetworkProfile {
  try {
    const val = localStorage.getItem(LS_KEY);
    if (
      val === 'normal' ||
      val === 'offline' ||
      val === 'flaky' ||
      val === 'slow' ||
      val === 'partition'
    ) {
      return val;
    }
  } catch {
    // Ignore localStorage errors (e.g. in tests)
  }
  return 'normal';
}

function saveProfile(p: NetworkProfile): void {
  try {
    localStorage.setItem(LS_KEY, p);
  } catch {
    // Ignore
  }
}

/** Simulate packet loss: randomly drop the call with given probability. */
async function maybeDropPacket(lossPct: number): Promise<void> {
  if (Math.random() < lossPct) {
    throw new Error('chaos: simulated packet loss');
  }
}

/** Simulate latency: wait between min and max ms. */
async function simulateLatency(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  await new Promise<void>((r) => setTimeout(r, delay));
}

export type ProfileChangeListener = (profile: NetworkProfile) => void;

export class ChaosTransport implements SyncTransport {
  private profile: NetworkProfile;
  private inner: SyncTransport;
  private listeners: ProfileChangeListener[] = [];

  constructor(inner: SyncTransport) {
    this.inner = inner;
    this.profile = loadProfile();
  }

  getProfile(): NetworkProfile {
    return this.profile;
  }

  setProfile(p: NetworkProfile): void {
    this.profile = p;
    saveProfile(p);
    this.listeners.forEach((l) => l(p));
  }

  onProfileChange(listener: ProfileChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private async applyProfile(): Promise<void> {
    switch (this.profile) {
      case 'normal':
        return; // no interference
      case 'offline':
      case 'partition':
        throw new Error('chaos: device is offline');
      case 'flaky':
        await maybeDropPacket(0.3);
        break;
      case 'slow':
        await simulateLatency(1000, 3000);
        break;
    }
  }

  async push(
    deviceId: string,
    userId: string,
    ops: Op[]
  ): Promise<{ results: ApplyResult[]; seq: number }> {
    await this.applyProfile();
    return this.inner.push(deviceId, userId, ops);
  }

  async pull(since: number, epoch?: string): Promise<PullResponse> {
    await this.applyProfile();
    return this.inner.pull(since, epoch);
  }

  async preview?(ops: Op[]): Promise<{ results: ApplyResult[] }> {
    await this.applyProfile();
    return this.inner.preview!(ops);
  }

  async resolveConflict?(
    conflictId: string,
    body: {
      choice: 'mine' | 'theirs' | 'custom';
      value?: FieldValue;
      userId: string;
      deviceId: string;
      opId: string;
      hlc: string;
    }
  ): Promise<{ ok: boolean }> {
    await this.applyProfile();
    return this.inner.resolveConflict!(conflictId, body);
  }

  connectWs?(onHint: (seq: number) => void): () => void {
    if (this.profile === 'offline' || this.profile === 'partition') {
      return () => {};
    }
    return this.inner.connectWs!(onHint);
  }
}
