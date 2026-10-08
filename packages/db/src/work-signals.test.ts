import { describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals, signalDatabaseWork, subscribeDatabaseWork } from "./work-signals.js";

type Connection = { transaction<T>(callback: (tx: Connection) => Promise<T>): Promise<T> };
function connection(commit?: () => void): Connection {
  return { async transaction<T>(callback: (tx: ReturnType<typeof connection>) => Promise<T>): Promise<T> {
    const result = await callback(connection());
    commit?.();
    return result;
  } };
}

describe("database work signals", () => {
  it("waits for the outer commit, including nested savepoints, and coalesces hints", async () => {
    const listener = vi.fn();
    const db = installDatabaseWorkSignals(connection(() => expect(listener).not.toHaveBeenCalled()));
    subscribeDatabaseWork(db, "queue", listener);
    await db.transaction(async tx => {
      signalDatabaseWork(tx, "queue");
      await tx.transaction(async nested => { signalDatabaseWork(nested, "queue"); });
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reconciles uncertain commits and rollbacks without changing their errors", async () => {
    const error = new Error("lost COMMIT response");
    const db = installDatabaseWorkSignals(connection(() => { throw error; }));
    const listener = vi.fn();
    subscribeDatabaseWork(db, "queue", listener);
    await expect(db.transaction(async tx => { signalDatabaseWork(tx, "queue"); })).rejects.toBe(error);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);
    await expect(db.transaction(async tx => {
      await tx.transaction(async nested => { signalDatabaseWork(nested, "queue"); throw error; });
    })).rejects.toBe(error);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it("keeps concurrent transaction hints isolated until their own commits", async () => {
    const db = installDatabaseWorkSignals(connection());
    const first = vi.fn(), second = vi.fn();
    subscribeDatabaseWork(db, "first", first);
    subscribeDatabaseWork(db, "second", second);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = db.transaction(async tx => { signalDatabaseWork(tx, "first"); await gate; });
    await db.transaction(async tx => { signalDatabaseWork(tx, "second"); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    release(); await pending;
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("retains uncertain writes made before a consumer subscribes", () => {
    const db = installDatabaseWorkSignals(connection());
    signalDatabaseWork(db, "queue", true);
    const first = vi.fn();
    subscribeDatabaseWork(db, "queue", first)();
    expect(first).toHaveBeenCalledWith(true);
    const replacement = vi.fn();
    subscribeDatabaseWork(db, "queue", replacement);
    expect(replacement).toHaveBeenCalledWith(true);
  });

  it("isolates databases and topics and releases subscriptions", () => {
    const db = installDatabaseWorkSignals(connection());
    const other = installDatabaseWorkSignals(connection());
    const listener = vi.fn();
    const unsubscribe = subscribeDatabaseWork(db, "queue", listener);
    signalDatabaseWork(other, "queue");
    signalDatabaseWork(db, "other");
    expect(listener).not.toHaveBeenCalled();
    signalDatabaseWork(db, "queue");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    signalDatabaseWork(db, "queue");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
