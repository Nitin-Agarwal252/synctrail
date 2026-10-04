export type ConnectivityListener = (isOnline: boolean) => void;

export interface ConnectivityOptions {
  fetchFn?: typeof fetch;
  getNavigatorOnLine?: () => boolean;
  heartbeatUrl?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export class ConnectivityManager {
  private isCurrentlyOnline: boolean;
  private listeners = new Set<ConnectivityListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly getNavigatorOnLine: () => boolean;
  private readonly heartbeatUrl: string;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private isChecking = false;

  constructor(options: ConnectivityOptions = {}) {
    this.fetchFn = options.fetchFn ?? (typeof fetch !== 'undefined' ? fetch.bind(window) : fetch);
    this.getNavigatorOnLine =
      options.getNavigatorOnLine ??
      (() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
    this.heartbeatUrl = options.heartbeatUrl ?? '/api/health';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 3000;

    // Start with browser report, but confirm with heartbeat
    this.isCurrentlyOnline = this.getNavigatorOnLine();
  }

  isOnline(): boolean {
    return this.isCurrentlyOnline;
  }

  onStatusChange(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(online: boolean) {
    if (this.isCurrentlyOnline !== online) {
      this.isCurrentlyOnline = online;
      for (const listener of this.listeners) {
        try {
          listener(online);
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  async checkNow(): Promise<boolean> {
    if (!this.getNavigatorOnLine()) {
      this.setStatus(false);
      return false;
    }

    if (this.isChecking) {
      return this.isCurrentlyOnline;
    }

    this.isChecking = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.heartbeatTimeoutMs);

    try {
      const res = await this.fetchFn(this.heartbeatUrl, {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const json = await res.json().catch(() => null);
        const valid = json && json.ok === true;
        this.setStatus(valid);
        return valid;
      } else {
        this.setStatus(false);
        return false;
      }
    } catch {
      clearTimeout(timeoutId);
      this.setStatus(false);
      return false;
    } finally {
      this.isChecking = false;
    }
  }

  start(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleBrowserOnline);
      window.addEventListener('offline', this.handleBrowserOffline);
    }

    // Immediate initial check
    this.checkNow();

    // Heartbeat ticker
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.checkNow();
      }, this.heartbeatIntervalMs);
    }
  }

  stop(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleBrowserOnline);
      window.removeEventListener('offline', this.handleBrowserOffline);
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private handleBrowserOnline = () => {
    // When browser reports online, confirm immediately via heartbeat
    this.checkNow();
  };

  private handleBrowserOffline = () => {
    // Immediate offline transition
    this.setStatus(false);
  };
}

export const connectivity = new ConnectivityManager();
