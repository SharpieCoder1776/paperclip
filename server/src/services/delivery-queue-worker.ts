import { subscribeDatabaseWork } from "@paperclipai/db";
import { beginIdleTrackedWork } from "./task-admission.js";

export const DELIVERY_QUEUES = {
  feedback: "feedback-exports",
  chatCompletion: "chat-completions",
  connection: "connection-continuations",
  question: "question-responses",
  toolAction: "tool-action-receipts",
} as const;

/**
 * Reconcile once at startup and on committed writes. Only outstanding work,
 * a failed reconciliation, or a deferred admission owns a retry timer. A
 * successful empty reconciliation disarms the worker until the next signal.
 */
export function createDeliveryQueueWorker(input: {
  db: object;
  topic: string;
  retryMs: number;
  run: () => Promise<unknown>;
  hasPending: () => Promise<boolean>;
  canRun: () => boolean;
  onError: (error: unknown) => void;
}) {
  let stopped = false;
  let dirty = false;
  let uncertainCommit = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function arm(delay: number) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      start();
    }, delay);
    timer.unref?.();
  }

  function start() {
    if (stopped || running) return;
    if (timer) clearTimeout(timer);
    timer = null;
    if (!input.canRun()) { arm(input.retryMs); return; }
    dirty = false;
    const finish = beginIdleTrackedWork();
    running = Promise.resolve().then(async () => {
      await input.run();
      return input.hasPending();
    }).then(pending => {
      if (pending || uncertainCommit) arm(input.retryMs);
    }).catch(error => {
      arm(input.retryMs);
      input.onError(error);
    }).finally(() => {
      running = null;
      finish();
      // A commit during either the sweep or its empty check must not be lost.
      if (dirty) arm(0);
    });
  }

  function wake(uncertain = false) {
    if (stopped) return;
    // A lost COMMIT acknowledgement can precede visibility on another
    // connection. Even observing other pending work cannot resolve that
    // ambiguity. Retain a conservative recovery backstop until restart.
    uncertainCommit ||= uncertain;
    dirty = true;
    if (!running) arm(0);
  }
  const unsubscribe = subscribeDatabaseWork(input.db, input.topic, wake);
  // Callers can await this first reconciliation before marking startup ready.
  const ready = Promise.resolve().then(() => { start(); return running; });
  return {
    ready,
    wake,
    async stop() {
      stopped = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
