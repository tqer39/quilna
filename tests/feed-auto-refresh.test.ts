import { afterEach, expect, test, vi } from "vitest";
import {
  FeedAutoRefresh,
  feedFailure,
  nextFeedRefresh,
} from "../src/feed-auto-refresh";
import type { Feed } from "../src/feed-parser";
afterEach(() => vi.useRealTimers());
const base = Date.parse("2026-10-24T00:00:00Z");
const feed = (url = "https://example.org/rss"): Feed => ({
  url,
  title: "Publisher",
  fetchedAt: new Date(base).toISOString(),
});
test("refresh intervals and persisted failure backoff are independent of reloads", () => {
  expect(nextFeedRefresh(feed(), 0)).toBe(Infinity);
  expect(nextFeedRefresh(feed(), 15)).toBe(base + 15 * 60_000);
  let failure = feedFailure(undefined, "unavailable", base);
  expect(failure.retryAt).toBe(base + 5 * 60_000);
  failure = feedFailure(failure, "unavailable", failure.retryAt);
  expect(failure.retryAt).toBe(base + 15 * 60_000);
  expect(nextFeedRefresh({ ...feed(), refreshFailure: failure }, 60)).toBe(
    failure.retryAt,
  );
  for (let i = 0; i < 20; i++)
    failure = feedFailure(failure, "unavailable", base);
  expect(failure.retryAt).toBe(base + 60 * 60_000);
});
test("scheduler waits until due, does not overlap cycles and stops starting work while paused", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(base);
  const feeds = [
    feed("https://example.org/1"),
    feed("https://example.org/2"),
    feed("https://example.org/3"),
  ];
  let enabled = true;
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const scheduler = new FeedAutoRefresh({
    feeds: () => feeds,
    interval: () => 15,
    canRun: () => enabled,
    failed: () => {},
    refresh: async (url) => {
      started.push(url);
      await new Promise<void>((resolve) => releases.push(resolve));
      feeds.find((f) => f.url === url)!.fetchedAt = new Date(
        Date.now(),
      ).toISOString();
    },
  });
  scheduler.start();
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  expect(started).toEqual([]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(started).toHaveLength(2);
  scheduler.wake();
  scheduler.wake();
  expect(started).toHaveLength(2);
  enabled = false;
  releases.splice(0).forEach((resolve) => resolve());
  await vi.advanceTimersByTimeAsync(30_000);
  expect(started).toHaveLength(2);
  enabled = true;
  scheduler.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toHaveLength(3);
  scheduler.stop();
  releases.splice(0).forEach((resolve) => resolve());
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(started).toHaveLength(3);
});
