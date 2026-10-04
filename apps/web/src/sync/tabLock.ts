export interface TabLock {
  requestLock(onAcquired: () => Promise<void>): Promise<void>;
  release(): void;
  isLeader(): boolean;
}

export class WebTabLock implements TabLock {
  private leader = false;
  private abortController: AbortController | null = null;

  isLeader(): boolean {
    return this.leader;
  }

  async requestLock(onAcquired: () => Promise<void>): Promise<void> {
    if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
      this.abortController = new AbortController();
      try {
        await navigator.locks.request(
          'synctrail_sync_leader',
          { signal: this.abortController.signal },
          async () => {
            this.leader = true;
            try {
              await onAcquired();
            } finally {
              this.leader = false;
            }
          }
        );
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Lock voluntarily released
          return;
        }
        throw err;
      }
    } else {
      // Fallback for environments without Web Locks API
      this.leader = true;
      try {
        await onAcquired();
      } finally {
        this.leader = false;
      }
    }
  }

  release(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.leader = false;
  }
}

export const tabLock = new WebTabLock();
