import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals, signalDatabaseWork } from "../../../packages/db/src/work-signals.js";
// Use the same module instance for the subscription and the test connection.
vi.mock("@paperclipai/db", async () => import("../../../packages/db/src/work-signals.js"));
import { createDeliveryQueueWorker, DELIVERY_QUEUES } from "../services/delivery-queue-worker.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const workers: ReturnType<typeof createDeliveryQueueWorker>[] = [];
afterEach(async () => { for (const worker of workers.splice(0)) await worker.stop(); vi.useRealTimers(); });
function setup(topic: string = DELIVERY_QUEUES.feedback) {
  vi.useFakeTimers();
  const db = installDatabaseWorkSignals({ transaction: vi.fn() });
  const input = { db, topic, retryMs: 1000, run: vi.fn(async () => {}),
    hasPending: vi.fn(async () => false), canRun: vi.fn(() => true), onError: vi.fn() };
  const worker = createDeliveryQueueWorker(input);
  workers.push(worker);
  return { ...input, worker, signal: () => signalDatabaseWork(db, topic) };
}

describe("delivery queue workers", () => {
  it.each(Object.values(DELIVERY_QUEUES))("%s stops all scans after startup and after a committed enqueue drains", async topic => {
    const s = setup(topic);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(s.run).toHaveBeenCalledTimes(1);
    s.signal(); s.signal();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries outstanding work and failures, then becomes quiet", async () => {
    const s = setup();
    s.run.mockRejectedValueOnce(new Error("DB unavailable"));
    s.hasPending.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.run).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a recovery backstop after an uncertain commit even if unrelated work drains", async () => {
    const s = setup();
    await s.worker.ready;
    signalDatabaseWork(s.db, s.topic, true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.run.mock.calls.length).toBeGreaterThan(3);
    expect(vi.getTimerCount()).toBe(1);
    s.hasPending.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not lose a commit racing the final empty check or overlap deliveries", async () => {
    const s = setup();
    let release!: (value: boolean) => void;
    s.hasPending.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    expect(idleWorkSnapshot().active).toBe(1);
    s.signal(); s.signal();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.run).toHaveBeenCalledTimes(1);
    release(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.run).toHaveBeenCalledTimes(2);
    expect(idleWorkSnapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers without querying during idle drain/standby and resumes pending recovery", async () => {
    const s = setup();
    s.canRun.mockReturnValue(false);
    s.signal();
    await vi.advanceTimersByTimeAsync(4000);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.hasPending).not.toHaveBeenCalled();
    s.canRun.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for accepted work on shutdown and ignores subsequent writes", async () => {
    const s = setup();
    let release!: () => void;
    s.run.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    const stopped = vi.fn();
    const stopping = s.worker.stop().then(stopped);
    s.signal();
    expect(stopped).not.toHaveBeenCalled();
    release(); await stopping;
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
