import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry, View } from "../lib/board/core.ts";
import type { Report } from "../lib/board/crew.ts";

const PLAN = "p1";
const LEASE_MS = 1500;
const WORK_MS = 500;
const REPO = "nanocodexyz/durable-vercel";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const lines = <T>(file: string): T[] => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as T);
  } catch {
    return [];
  }
};

const paths = (dir: string) => ({ data: join(dir, "workflow"), reports: join(dir, "reports.jsonl"), lead: join(dir, "lead.jsonl"), drives: join(dir, "drives.jsonl") });

const issue = (action: string) => ({ action, repository: { full_name: REPO }, issue: { number: 7, title: "Payout webhook retries twice", html_url: "https://github.com/" + REPO + "/issues/7" }, sender: { login: "octocat" } });

const comment = { action: "created", repository: { full_name: REPO }, issue: { number: 7 }, comment: { body: "Seen again on retry", user: { login: "octocat" } } };

const args = process.argv.slice(2);
if (args[0] === "child") await child(args[1] as "start" | "resume", args[2]!, args[3]);
else await rounds(Number(args[0] ?? 3));

async function child(phase: "start" | "resume", dir: string, resumed?: string) {
  const files = paths(dir);
  process.env.WORKFLOW_LOCAL_DATA_DIR = files.data;
  const [{ durableAgent, getWorld }, Board, { client }, Crew, GitHub] = await Promise.all([
    import("durable-harness"),
    import("../lib/board/harness.ts"),
    import("../lib/board/client.ts"),
    import("../lib/board/crew.ts"),
    import("../lib/board/github.ts"),
  ]);
  const agent = durableAgent({ harness: Board.create({ report: report => appendFileSync(files.drives, JSON.stringify({ pid: process.pid, phase, ...report }) + "\n") }), durability: "on" });
  const world = await getWorld();
  const sessionId = resumed ?? (await agent.sessions.start()).sessionId;
  if (phase === "start") process.stdout.write(JSON.stringify({ sessionId }) + "\n");
  const board = client(agent.sessions, sessionId, { timeoutMs: 60_000 });
  const ingest = async (event: string, delivery: string, payload: object) => {
    const op = GitHub.toOp(event, payload as never)!;
    return board.write(GitHub.deliveryKey(delivery), op, GitHub.SOURCE);
  };
  const chartered = await Crew.charter(board);
  appendFileSync(files.lead, JSON.stringify({ phase, chartered }) + "\n");
  const led = await Crew.lead(board, PLAN);
  appendFileSync(files.lead, JSON.stringify({ phase, verdicts: led }) + "\n");
  const opened = await ingest("issues", "delivery-1", issue("opened"));
  appendFileSync(files.lead, JSON.stringify({ phase, delivery: "delivery-1", verdict: opened }) + "\n");
  const report = (entry: Report) => appendFileSync(files.reports, JSON.stringify({ pid: process.pid, phase, ...entry }) + "\n");
  const names = phase === "start" ? ["agent:w1", "agent:w2", "agent:w3"] : ["agent:r1", "agent:r2", "agent:r3"];
  const done = (view: View) => Crew.settledUnder(PLAN + "/")(view) && view.tasks.filter(task => task.id.startsWith("github/")).every(task => task.phase.state !== "open" && task.phase.state !== "claimed");
  const workers = Crew.crew(board, names, { leaseMs: LEASE_MS, workMs: WORK_MS, pollMs: 100, done, report });
  if (phase === "start") {
    await workers;
    await new Promise(() => undefined);
  }
  const replies = [await ingest("issue_comment", "delivery-2", comment), await ingest("issue_comment", "delivery-2", comment), await ingest("issues", "delivery-1", issue("opened"))];
  appendFileSync(files.lead, JSON.stringify({ phase, replies }) + "\n");
  await workers;
  const { view, entries } = await board.snapshot(0);
  const state = await agent.sessions.inspect(sessionId);
  const sql = readdirSync(join(files.data, "events"), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as { eventType: string; eventData?: { stepName?: string } }).filter(event => event.eventType === "step_completed" && event.eventData?.stepName?.endsWith("nanocode.sql")).length;
  process.stdout.write(JSON.stringify({ sessionId, view, entries, events: state.eventCount, sql_steps: sql }) + "\n");
  await world.close?.();
  process.exit(0);
}

function launch(args: string[]): ChildProcess {
  return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--v8-pool-size=2", fileURLToPath(import.meta.url), "child", ...args], { env: { ...process.env, UV_THREADPOOL_SIZE: "2" }, stdio: ["ignore", "pipe", "inherit"] });
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout!.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) resolve(buffer.slice(0, end));
    });
    child.on("exit", code => reject(new Error("child exited " + code + " before writing a line")));
  });
}

function exited(child: ChildProcess) {
  return new Promise(resolve => (child.exitCode !== null ? resolve(child.exitCode) : child.on("exit", resolve)));
}

async function rounds(count: number) {
  const results = [];
  for (let round = 0; round < count; round++) results.push(await orchestrate(round, 1 + (round % 4)));
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  process.exit(results.every(result => result.ok) ? 0 : 1);
}

async function orchestrate(round: number, killAfter: number) {
  const dir = resolve(process.env.BOARD_DRILL_DIR ?? join(process.env.TMPDIR ?? "/tmp", "board-drill"), "round-" + round);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = paths(dir);
  const startedAt = performance.now();
  const first = launch(["start", dir]);
  const { sessionId } = JSON.parse(await firstLine(first)) as { sessionId: string };
  const deadline = Date.now() + 60_000;
  while (lines<Report>(files.reports).filter(report => report.kind === "finished").length < killAfter) {
    if (Date.now() > deadline) throw new Error("the first crew finished nothing in 60s");
    await sleep(10);
  }
  const killedAt = lines<Report>(files.reports);
  first.kill("SIGKILL");
  await exited(first);
  const killed_ms = performance.now() - startedAt;
  const second = launch(["resume", dir, sessionId]);
  const summary = JSON.parse(await firstLine(second)) as { view: View; entries: Entry[]; events: number; sql_steps: number };
  await exited(second);
  const reports = lines<Report & { phase: string }>(files.reports);
  const led = lines<{ phase: string; verdicts?: Record<string, unknown>; delivery?: string; verdict?: unknown; replies?: unknown[] }>(files.lead);
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => ok || failures.push(message);
  const tasks = summary.view.tasks;
  const expected = ["schema", "api", "api.1", "api.2", "ui", "docs", "ship"].map(id => PLAN + "/" + id).concat(["github/" + REPO + "#7"]);
  for (const id of expected) {
    const task = tasks.find(entry => entry.id === id);
    check(task?.phase.state === "done", id + " is " + (task?.phase.state ?? "missing") + ", not done");
    const changes = summary.entries.filter(entry => entry.task === id);
    check(changes.filter(entry => entry.change.kind === "posted").length === 1, id + " was posted " + changes.filter(entry => entry.change.kind === "posted").length + " times");
    check(changes.filter(entry => entry.change.kind === "finished").length === 1, id + " finished " + changes.filter(entry => entry.change.kind === "finished").length + " times");
  }
  check(tasks.length === expected.length, "the board holds " + tasks.length + " tasks, not " + expected.length);
  const plans = led.filter(entry => entry.verdicts);
  check(plans.length === 2 && JSON.stringify(plans[0]!.verdicts) === JSON.stringify(plans[1]!.verdicts), "the lead's replayed plan did not settle to the same rows");
  const issueTask = tasks.find(entry => entry.id === "github/" + REPO + "#7");
  check(issueTask?.replies.length === 1, "the redelivered comment left " + (issueTask?.replies.length ?? 0) + " replies, not 1");
  const finishedBefore = killedAt.filter(report => report.kind === "finished").map(report => report.task);
  const finishedAfter = reports.filter(report => report.phase === "resume" && report.kind === "finished").map(report => report.task);
  check(finishedAfter.every(task => !finishedBefore.includes(task)), "a task the first crew finished was finished again after the restart");
  check(finishedBefore.length + finishedAfter.length === expected.length, "the crews finished " + (finishedBefore.length + finishedAfter.length) + " tasks between them, not " + expected.length);
  const before = new Set(["agent:w1", "agent:w2", "agent:w3"]);
  const orphaned = summary.entries.filter(entry => entry.change.kind === "claimed" && before.has(entry.change.worker) && !summary.entries.some(other => other.task === entry.task && other.change.kind === "finished" && other.seq > entry.seq && finishedBefore.includes(entry.task))).map(entry => entry.task);
  const tookOver = summary.entries.filter(entry => entry.change.kind === "claimed" && entry.change.took_over).map(entry => entry.task);
  check(summary.sql_steps > 0, "no nanocode.sql Workflow step completed");
  return { round, kill_after_finishes: killAfter, ok: failures.length === 0, failures, session: sessionId, killed_ms: Math.round(killed_ms), finished_before_kill: finishedBefore, claims_orphaned_by_kill: orphaned, taken_over_after_kill: tookOver, finished_after_restart: finishedAfter, board_rows: summary.view.next - 1, sql_steps: summary.sql_steps, workflow_events: summary.events, workers: [...new Set(reports.map(report => report.worker))] };
}
