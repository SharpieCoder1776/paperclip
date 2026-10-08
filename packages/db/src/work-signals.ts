/** Process-local hints for durable work. The database remains the source of truth. */
type Listener = (uncertainCommit: boolean) => void;
type Scope = { listeners: Map<string, Set<Listener>> };
type Context = { scope: Scope; pending: Set<string> | null };
const contexts = new WeakMap<object, Context>();

// Drizzle transactions can contain savepoints and can be supplied by callers.
// Instrument each transaction at creation so a hint cannot escape an outer
// transaction before commit. No SQL, connection, or timer is added here.
type Transactional = { transaction: (...args: any[]) => Promise<any> };
export function installDatabaseWorkSignals<T extends Transactional>(db: T): T {
  install(db, { scope: { listeners: new Map() }, pending: null });
  return db;
}

function publish(scope: Scope, topic: string, uncertainCommit = false) {
  for (const listener of scope.listeners.get(topic) ?? []) {
    try { listener(uncertainCommit); }
    catch (error) { process.emitWarning(`Database work listener failed: ${String(error)}`); }
  }
}

function install(connection: Transactional, context: Context) {
  contexts.set(connection, context);
  const transaction = connection.transaction;
  connection.transaction = async function (callback, ...options) {
    const pending = new Set<string>();
    let callbackCompleted = false;
    let committed = false;
    try {
      const result = await transaction.call(this, async (tx: Transactional) => {
        install(tx, { scope: context.scope, pending });
        const result = await callback(tx);
        callbackCompleted = true;
        return result;
      }, ...options);
      committed = true;
      return result;
    } finally {
      // Also reconcile after failure: a lost COMMIT response is ambiguous.
      // A rollback merely causes one harmless empty reconciliation. Nested
      // hints are deferred until the outermost transaction settles.
      for (const topic of pending) {
        if (context.pending) context.pending.add(topic);
        else publish(context.scope, topic, callbackCompleted && !committed);
      }
    }
  };
}

/** Signal before a transactional write; signal autocommit success/failure after settlement. */
export function signalDatabaseWork(connection: object, topic: string, uncertainCommit = false): void {
  const context = contexts.get(connection);
  if (!context) return; // Non-runtime database doubles do not have consumers.
  if (context.pending) context.pending.add(topic);
  else publish(context.scope, topic, uncertainCommit);
}

/** Subscribe before the initial durable reconciliation to close the startup gap. */
export function subscribeDatabaseWork(connection: object, topic: string, listener: Listener): () => void {
  const context = contexts.get(connection);
  if (!context) throw new Error("Database work subscriptions require createDb");
  let listeners = context.scope.listeners.get(topic);
  if (!listeners) context.scope.listeners.set(topic, listeners = new Set());
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
