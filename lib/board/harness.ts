import type { DriveContext, Harness, Submission } from "durable-harness";
import { Journal } from "nanocode-ts/vercel";
import { Core, type Op, type Verdict } from "./core.ts";

export const SCOPE = "board";

export type Command = { key: string; by?: string; at_ms?: number; op: Op };

const VERDICTS = "CREATE TABLE IF NOT EXISTS board_verdicts (submission TEXT PRIMARY KEY, key TEXT NOT NULL, verdict TEXT NOT NULL)";

export const ANONYMOUS = "user:anonymous";

export const command = (key: string, op: Op, by = ANONYMOUS, at_ms = Date.now()): string => JSON.stringify({ key, by, at_ms, op } satisfies Command);

const parse = (submission: Submission): Command | undefined => {
  try {
    const value = JSON.parse(submission.text ?? "") as Command;
    return typeof value.key === "string" && value.op && typeof value.op === "object" ? value : undefined;
  } catch {
    return undefined;
  }
};

export type Options = {
  durability?: Journal.Durability;
  report?: (report: { submission: string; key: string; verdict: Verdict | "ignored"; runId: string }) => void;
};

export function create(options: Options = {}): Harness {
  return {
    name: "board",
    async drive(ctx: DriveContext) {
      const journal = Journal.create(ctx, { durability: options.durability ?? "on" });
      try {
        const cores = new Map<string, Promise<Core>>();
        const writer = (by: string) => {
          let core = cores.get(by);
          if (!core) cores.set(by, (core = Core.open(journal, SCOPE, by)));
          return core;
        };
        await writer(ANONYMOUS);
        await journal.transaction("log", "board_verdicts_schema", [[VERDICTS]], "schema");
        const placed = new Set<string>();
        for (;;) {
          const pending = ctx.pending().filter(submission => !placed.has(submission.id));
          if (pending.length === 0) {
            await ctx.refresh();
            if (ctx.pending().every(submission => placed.has(submission.id))) break;
            continue;
          }
          for (const submission of pending) {
            const written = parse(submission);
            const verdict = written ? await (await writer(written.by ?? ANONYMOUS)).submit(written.key, written.at_ms ?? Date.now(), written.op) : "ignored";
            await journal.transaction("log", "board_verdict", [["INSERT OR REPLACE INTO board_verdicts (submission, key, verdict) VALUES (?, ?, ?)", submission.id, written?.key ?? "", JSON.stringify(verdict)]], "write");
            journal.place([submission.id]);
            placed.add(submission.id);
            options.report?.({ submission: submission.id, key: written?.key ?? "", verdict, runId: ctx.runId });
          }
        }
        await journal.settle();
      } finally {
        journal.close();
      }
    },
  };
}

type Sql = ReturnType<typeof Journal.read>["sql"];

export const verdictOf = (sql: Sql, submission: string): Verdict | "ignored" | null => {
  try {
    const row = sql.run([["SELECT verdict FROM board_verdicts WHERE submission = ?", submission]], "read")[0]?.[0]?.[0];
    return typeof row === "string" ? (JSON.parse(row) as Verdict | "ignored") : null;
  } catch {
    return null;
  }
};

export { isSettled } from "durable-harness";
