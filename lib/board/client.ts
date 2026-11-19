import { type DurableSessions, isSettled, type SessionState } from "durable-harness";
import { Journal } from "nanocode-ts/vercel";
import { Core, type Entry, type Op, type SqlHost, type Verdict, type View } from "./core.ts";
import { ANONYMOUS, command, SCOPE, verdictOf } from "./harness.ts";

export type Snapshot = { view: View; entries: Entry[] };

export type Client = {
  board: string;
  write(key: string, op: Op, by?: string, at_ms?: number): Promise<Verdict>;
  send(key: string, op: Op, by?: string, at_ms?: number): Promise<string>;
  settled(submission: string, key: string, by?: string): Promise<Verdict>;
  view(at_ms?: number): Promise<View>;
  snapshot(after?: number, at_ms?: number): Promise<Snapshot>;
};

type Sql = ReturnType<typeof Journal.read>["sql"];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const run = (sql: Sql, statements: Parameters<Sql["run"]>[0], _access?: string) =>
  statements.map(statement => {
    if (/^\s*CREATE\s/i.test(statement[0])) return [];
    try {
      return sql.run([statement], "read")[0] ?? [];
    } catch (error) {
      if (/no such table/i.test(String(error))) return [];
      throw error;
    }
  });

export function client(sessions: DurableSessions, board: string, options: { pollMs?: number; timeoutMs?: number } = {}): Client {
  const pollMs = options.pollMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const replicas = Journal.replicas({ bytes: 256 << 20 });
  let current: Sql | undefined;
  const host: SqlHost = { transaction: (_kind, _operation, statements, access) => run(current!, statements, access) };
  let core: Promise<Core> | undefined;
  let lock: Promise<unknown> = Promise.resolve();
  let last: { at: number; state: SessionState } | undefined;
  const inspect = async () => {
    if (last && Date.now() - last.at < pollMs / 2) return last.state;
    const state = await sessions.inspect(board);
    last = { at: Date.now(), state };
    return state;
  };
  const reading = <T>(f: (core: Core, state: SessionState, sql: Sql) => Promise<T>): Promise<T> => {
    const work = lock.then(async () => {
      const state = await inspect();
      const replica = Journal.read(state, replicas);
      current = replica.sql;
      try {
        const opened = (core ??= Core.open(host, SCOPE, "user:reader"));
        const reader = await opened.catch(error => {
          core = undefined;
          throw error;
        });
        await reader.refresh();
        return await f(reader, state, replica.sql);
      } finally {
        current = undefined;
        replica.close();
      }
    });
    lock = work.catch(() => undefined);
    return work;
  };
  const send = (key: string, op: Op, by?: string, at_ms?: number) => sessions.send(board, command(key, op, by, at_ms), "prompt");
  const settled = async (submission: string, key: string, by = ANONYMOUS) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const verdict = await reading(async (reader, state, sql) => {
        if (state.status === "failed") throw new Error("the board session failed: " + state.failure?.message);
        if (!isSettled(state, submission)) return null;
        return verdictOf(sql, submission) ?? (await reader.outcome(by, key));
      });
      if (verdict === "ignored") throw new Error("the board ignored " + key);
      if (verdict) return verdict;
      if (Date.now() > deadline) throw new Error("the board did not settle " + key + " in " + timeoutMs + "ms");
      await sleep(pollMs);
    }
  };
  return {
    board,
    send,
    settled,
    write: async (key, op, by, at_ms) => settled(await send(key, op, by, at_ms), key, by),
    view: at_ms => reading(reader => reader.view(at_ms)),
    snapshot: (after = 0, at_ms) => reading(async reader => ({ view: await reader.view(at_ms), entries: await reader.entries(after) })),
  };
}
