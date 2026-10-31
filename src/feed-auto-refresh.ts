import type { Feed } from "./feed-parser";
export const feedRefreshPreferencesKey = "quilna.feed.refresh.v1";
export const refreshIntervals = [0, 15, 30, 60] as const;
export type FeedRefreshFailure = {
  failures: number;
  retryAt: number;
  error: string;
};
export function readRefreshInterval(): number {
  try {
    const value = JSON.parse(
      localStorage.getItem(feedRefreshPreferencesKey) ?? "15",
    );
    return refreshIntervals.includes(value) ? value : 15;
  } catch {
    return 15;
  }
}
export function nextFeedRefresh(feed: Feed, intervalMinutes: number): number {
  if (!intervalMinutes || feed.unsubscribed) return Infinity;
  return (
    feed.refreshFailure?.retryAt ??
    Date.parse(feed.fetchedAt) + intervalMinutes * 60_000
  );
}
export function feedFailure(
  previous: FeedRefreshFailure | undefined,
  error: string,
  now = Date.now(),
): FeedRefreshFailure {
  const failures = Math.min((previous?.failures ?? 0) + 1, 8);
  return {
    failures,
    retryAt: now + Math.min(5 * 2 ** (failures - 1), 60) * 60_000,
    error: error.slice(0, 2000),
  };
}
let localRunning = 0;
const localFeeds = new Set<string>();
export function feedLockSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.locks;
}
// Two origin-wide slots and a per-feed lock cover both manual and automatic calls.
// Unsupported browsers keep manual refresh with an in-tab limit; automation is disabled.
export async function withFeedRefreshLock(
  address: string,
  job: () => Promise<void>,
): Promise<boolean> {
  if (!feedLockSupported()) {
    if (localRunning >= 2 || localFeeds.has(address)) return false;
    localRunning++;
    localFeeds.add(address);
    try {
      await job();
      return true;
    } finally {
      localRunning--;
      localFeeds.delete(address);
    }
  }
  for (const slot of [0, 1]) {
    const result = await navigator.locks.request(
      `quilna.rss.slot.${slot}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return false;
        return navigator.locks.request(
          `quilna.rss.feed.${address}`,
          { ifAvailable: true },
          async (feedLock) => {
            if (!feedLock) return false;
            await job();
            return true;
          },
        );
      },
    );
    if (result) return true;
  }
  return false;
}
export class FeedAutoRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private started = false;
  constructor(
    private options: {
      feeds: () => Feed[];
      interval: () => number;
      canRun: () => boolean;
      refresh: (address: string) => Promise<void>;
      failed: (error: unknown) => void;
    },
  ) {}
  start() {
    this.started = true;
    this.wake();
  }
  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  wake() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || this.running || !this.options.canRun()) return;
    void this.run();
  }
  private async run() {
    this.running = true;
    try {
      const now = Date.now();
      const queue = this.options
        .feeds()
        .filter(
          (feed) => nextFeedRefresh(feed, this.options.interval()) <= now,
        );
      await Promise.all(
        [0, 1].map(async () => {
          while (queue.length && this.started && this.options.canRun()) {
            const feed = queue.shift()!;
            await this.options.refresh(feed.url);
          }
        }),
      );
    } catch (error) {
      this.options.failed(error);
    } finally {
      this.running = false;
      if (this.started && this.options.canRun())
        this.timer = setTimeout(() => this.wake(), 15_000);
    }
  }
}
