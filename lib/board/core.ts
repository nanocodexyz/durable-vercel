import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal } from "nanocode-ts/vercel";

export const WASM_PATH = join(process.cwd(), "lib/board/board.wasm");

type Statement = Parameters<Journal.Journal["transaction"]>[2][number];

type Access = "read" | "write" | "schema";

export type SqlHost = {
  transaction(kind: "log", operation: string, statements: Statement[], access?: Access): unknown;
};

type Exports = {
  memory: WebAssembly.Memory;
  board_alloc(len: number): number;
  board_free(ptr: number, len: number): void;
  board_call(ptr: number, len: number): number;
  board_resume(ptr: number, len: number): number;
  board_abandon(): void;
  board_out_ptr(): number;
  board_out_len(): number;
};

export type Phase =
  | { state: "open" }
  | { state: "claimed"; claim: string; worker: string; until_ms: number }
  | { state: "done"; result: string }
  | { state: "failed"; error: string }
  | { state: "cancelled"; reason: string };

export type Task = { id: string; parent: string | null; spec: string; labels: Record<string, string>; needs: string[]; phase: Phase; attempts: number; replies: { by: string; body: string }[] };

export type View = { next: number; now_ms: number; settled: boolean; ready: string[]; tasks: Task[] };

export type Change =
  | { kind: "posted" }
  | { kind: "claimed"; claim: string; worker: string; until_ms: number; took_over: string | null }
  | { kind: "renewed"; claim: string; until_ms: number }
  | { kind: "released"; claim: string; note: string }
  | { kind: "finished"; outcome: { kind: "done" | "failed"; detail: string } }
  | { kind: "cancelled"; reason: string }
  | { kind: "replied"; by: string; body: string };

export type Entry = { seq: number; event: string; at_ms: number; task: string; change: Change };

export type NewTask = { id: string; parent: string | null; spec: string; labels: Record<string, string>; needs: string[] };

export type Op =
  | { op: "post"; task: NewTask }
  | { op: "claim"; task: string; lease_ms: number }
  | { op: "renew"; task: string; claim: string; lease_ms: number }
  | { op: "release"; task: string; claim: string; note: string }
  | { op: "finish"; task: string; claim: string; outcome: { kind: "done" | "failed"; detail: string } }
  | { op: "cancel"; task: string; reason: string }
  | { op: "reply"; task: string; body: string }
  | { op: "charter" }
  | { op: "grant"; grant: Grant }
  | { op: "revoke"; grant: string };

export type Can = "read" | "post" | "react" | "label" | "sync" | "manage";

export type Grant = { who: ({ kind: "principal"; id: string } | { kind: "kind"; id: string } | { kind: "everyone" })[]; can: Record<string, Can[]> };

export type Verdict = { seq: number } | { rejected: string };

type Reply<T> = { ok: T } | { rejected: string } | { error: string } | { unsettled: string; error: string };

let compiled: Promise<WebAssembly.Module> | undefined;

const module = () => (compiled ??= WebAssembly.compile(readFileSync(WASM_PATH)));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const access = (operation: string): Access => (operation === "turn_log_scan" ? "read" : "write");

const failure = (reply: { error?: string; rejected?: string }) => reply.rejected ?? reply.error ?? "unknown failure";

export class BoardError extends Error {
  readonly reply: unknown;

  constructor(message: string, reply: unknown) {
    super(message);
    this.reply = reply;
  }
}

export class Core {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly exports: Exports;
  private readonly host: SqlHost;

  private constructor(exports: Exports, host: SqlHost) {
    this.exports = exports;
    this.host = host;
  }

  static async open(host: SqlHost, scope: string, actor: string): Promise<Core> {
    const instance = await WebAssembly.instantiate(await module(), {});
    const core = new Core(instance.exports as unknown as Exports, host);
    await core.call({ call: "open", scope, actor });
    return core;
  }
  async submit(key: string, at_ms: number, op: Op): Promise<Verdict> {
    const reply = await this.raw<{ seq: number; event: string }>({ call: "submit", key, at_ms, op });
    if ("ok" in reply) return { seq: reply.ok.seq };
    if ("rejected" in reply) return { rejected: reply.rejected };
    throw new BoardError("board submit " + key + ": " + failure(reply), reply);
  }

  refresh(): Promise<{ next: number }> {
    return this.call({ call: "refresh" });
  }

  view(at_ms = Date.now()): Promise<View> {
    return this.call({ call: "view", at_ms });
  }

  entries(after = 0): Promise<Entry[]> {
    return this.call({ call: "entries", after });
  }

  outcome(actor: string, key: string): Promise<Verdict | null> {
    return this.call({ call: "outcome", actor, key });
  }

  private async call<T>(call: { call: string; [field: string]: unknown }): Promise<T> {
    const reply = await this.raw<T>(call);
    if ("ok" in reply) return reply.ok;
    throw new BoardError("board " + call.call + ": " + failure(reply), reply);
  }

  private raw<T>(call: object): Promise<Reply<T>> {
    const run = this.queue.then(() => this.drive<T>(call));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async drive<T>(call: object): Promise<Reply<T>> {
    let status = this.invoke("board_call", JSON.stringify(call));
    try {
      while (status === 1) {
        const request = JSON.parse(this.out()) as { operation: string; statements: Statement[] };
        let response: { rows: unknown } | { error: string };
        try {
          response = { rows: await this.host.transaction("log", request.operation, request.statements, access(request.operation)) };
        } catch (error) {
          response = { error: error instanceof Error ? error.message : String(error) };
        }
        status = this.invoke("board_resume", JSON.stringify(response));
      }
    } catch (error) {
      this.exports.board_abandon();
      throw error;
    }
    return JSON.parse(this.out()) as Reply<T>;
  }

  private invoke(name: "board_call" | "board_resume", text: string): number {
    const bytes = encoder.encode(text);
    const ptr = this.exports.board_alloc(bytes.length);
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      return this.exports[name](ptr, bytes.length);
    } finally {
      this.exports.board_free(ptr, bytes.length);
    }
  }

  private out(): string {
    return decoder.decode(new Uint8Array(this.exports.memory.buffer, this.exports.board_out_ptr(), this.exports.board_out_len()));
  }
}
