import { createHmac, timingSafeEqual } from "node:crypto";
import type { Op } from "./core.ts";

type Payload = { action?: string; repository?: { full_name?: string }; issue?: { number?: number; title?: string; html_url?: string }; comment?: { body?: string; user?: { login?: string } }; sender?: { login?: string } };

export const taskId = (repository: string, issue: number) => "github/" + repository + "#" + issue;

export function toOp(event: string, payload: Payload): Op | undefined {
  const repository = payload.repository?.full_name;
  const number = payload.issue?.number;
  if (!repository || number === undefined) return undefined;
  const task = taskId(repository, number);
  if (event === "issues" && (payload.action === "opened" || payload.action === "reopened")) {
    return { op: "post", task: { id: task, parent: null, spec: payload.issue?.title ?? task, labels: { source: "github", url: payload.issue?.html_url ?? "" }, needs: [] } };
  }
  if (event === "issues" && payload.action === "closed") return { op: "cancel", task, reason: "closed on GitHub by " + (payload.sender?.login ?? "someone") };
  if (event === "issue_comment" && payload.action === "created") return { op: "reply", task, body: (payload.comment?.user?.login ?? "someone") + ": " + (payload.comment?.body ?? "") };
  return undefined;
}

export const deliveryKey = (delivery: string) => "gh:" + delivery;

export const SOURCE = "source:github";

export function verify(secret: string | undefined, body: string, signature: string | null): boolean {
  if (!secret) return true;
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
