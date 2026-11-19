import type { Client } from "./client.ts";
import type { Task, View } from "./core.ts";

export type PlanTask = { id: string; spec: string; needs?: string[]; split?: number };

export const demoPlan: PlanTask[] = [
  { id: "schema", spec: "Define the payout schema" },
  { id: "api", spec: "Build the payouts API", needs: ["schema"], split: 2 },
  { id: "ui", spec: "Build the payouts page", needs: ["schema"] },
  { id: "docs", spec: "Write the payouts docs", needs: ["api", "ui"] },
  { id: "ship", spec: "Ship payouts", needs: ["docs"] },
];

export type Report = { worker: string; task: string; kind: "claimed" | "finished" | "lost" | "split"; claim: string; seq?: number; at: number };

export type WorkerOptions = {
  leaseMs?: number;
  workMs?: number;
  pollMs?: number;
  done?: (view: View) => boolean;
  report?: (report: Report) => void;
  signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const terminal = (task: Task) => task.phase.state === "done" || task.phase.state === "failed" || task.phase.state === "cancelled";

export const settledUnder = (prefix: string) => (view: View) => {
  const tasks = view.tasks.filter(task => task.id.startsWith(prefix));
  return tasks.length > 0 && tasks.every(terminal);
};

export const LEAD = "user:lead";

export const agentName = (name: string) => (name.includes(":") ? name : "agent:" + name);

export async function charter(board: Client) {
  const verdicts = [await board.write("charter", { op: "charter" }, LEAD)];
  verdicts.push(await board.write("grant:agents", { op: "grant", grant: { who: [{ kind: "kind", id: "agent" }], can: { "*": ["read", "post", "label"] } } }, LEAD));
  verdicts.push(await board.write("grant:sources", { op: "grant", grant: { who: [{ kind: "kind", id: "source" }], can: { "*": ["read", "post"] } } }, LEAD));
  return verdicts;
}

export async function lead(board: Client, plan: string, tasks: PlanTask[] = demoPlan) {
  const verdicts: Record<string, unknown> = {};
  for (const task of tasks) {
    verdicts[task.id] = await board.write("lead:" + plan + ":" + task.id, {
      op: "post",
      task: { id: plan + "/" + task.id, parent: null, spec: task.spec, labels: task.split ? { split: String(task.split), plan } : { plan }, needs: (task.needs ?? []).map(need => plan + "/" + need) },
    }, LEAD);
  }
  return verdicts;
}

const order = (name: string, ids: string[]) => {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ids.map((id, i) => ({ id, rank: (i * 7919 + hash) % 104729 })).sort((a, b) => a.rank - b.rank).map(entry => entry.id);
};

export async function worker(board: Client, agent: string, options: WorkerOptions = {}) {
  const name = agentName(agent);
  const leaseMs = options.leaseMs ?? 3000;
  const workMs = options.workMs ?? 600;
  const pollMs = options.pollMs ?? 150;
  const done = options.done ?? (view => view.tasks.length > 0 && view.tasks.every(terminal));
  const report = (task: string, kind: Report["kind"], claim: string, seq?: number) => options.report?.({ worker: name, task, kind, claim, seq, at: Date.now() });
  let renewals = 0;
  const renew = async (task: string, claim: string) => {
    const verdict = await board.write("renew:" + claim + ":" + renewals++, { op: "renew", task, claim, lease_ms: leaseMs }, name);
    return "seq" in verdict;
  };
  const work = async (task: Task, claim: string): Promise<string | undefined> => {
    const parts = Number(task.labels.split ?? 0);
    if (parts > 0) {
      const children = Array.from({ length: parts }, (_, i) => task.id + "." + (i + 1));
      for (const [i, child] of children.entries()) {
        await board.write("split:" + task.id + ":" + (i + 1), { op: "post", task: { id: child, parent: task.id, spec: task.spec + " (part " + (i + 1) + " of " + parts + ")", labels: { plan: task.labels.plan ?? "" }, needs: [] } }, name);
      }
      report(task.id, "split", claim);
      for (;;) {
        const view = await board.view();
        const mine = view.tasks.filter(entry => children.includes(entry.id));
        if (mine.length === parts && mine.every(terminal)) return mine.map(child => child.id + ": " + (child.phase.state === "done" ? child.phase.result : child.phase.state)).join("; ");
        if (!(await renew(task.id, claim))) return undefined;
        await sleep(Math.min(pollMs * 2, leaseMs / 3));
      }
    }
    const step = Math.max(1, Math.floor(leaseMs / 3));
    for (let spent = 0; spent < workMs; spent += step) {
      await sleep(Math.min(step, workMs - spent));
      if (spent + step < workMs && !(await renew(task.id, claim))) return undefined;
    }
    return name + " did " + JSON.stringify(task.spec) + (task.replies.length ? " (" + task.replies.length + " replies)" : "");
  };
  while (!options.signal?.aborted) {
    const view = await board.view();
    if (done(view)) return;
    let worked = false;
    for (const id of order(name, view.ready)) {
      const task = view.tasks.find(entry => entry.id === id)!;
      const key = "claim:" + id + ":" + task.attempts;
      const claim = name + "#" + key;
      const claimed = await board.write(key, { op: "claim", task: id, lease_ms: leaseMs }, name);
      if (!("seq" in claimed)) continue;
      report(id, "claimed", claim, claimed.seq);
      const result = await work(task, claim);
      const finished = result === undefined ? undefined : await board.write("finish:" + claim, { op: "finish", task: id, claim, outcome: { kind: "done", detail: result } }, name);
      if (finished && "seq" in finished) report(id, "finished", claim, finished.seq);
      else report(id, "lost", claim);
      worked = true;
      break;
    }
    if (!worked) await sleep(pollMs);
  }
}

export const crew = (board: Client, names: string[], options: WorkerOptions = {}) => Promise.all(names.map(name => worker(board, name, options)));
