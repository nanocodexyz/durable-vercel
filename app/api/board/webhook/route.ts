import { board } from "@/lib/board/agent";
import { deliveryKey, SOURCE, toOp, verify } from "@/lib/board/github";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("board") ?? process.env.BOARD_SESSION;
  if (!id) return Response.json({ error: "board is required" }, { status: 400 });
  const text = await request.text();
  if (!verify(process.env.BOARD_WEBHOOK_SECRET, text, request.headers.get("x-hub-signature-256"))) return new Response("bad signature", { status: 401 });
  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery");
  if (!delivery) return Response.json({ error: "x-github-delivery is required" }, { status: 400 });
  const payload = JSON.parse(text);
  const op = toOp(event, payload);
  if (!op) return Response.json({ ignored: event }, { status: 202 });
  const key = deliveryKey(delivery);
  const client = board(id);
  const submission = await client.send(key, op, SOURCE);
  const verdict = await Promise.race([client.settled(submission, key, SOURCE), new Promise(resolve => setTimeout(resolve, 8000, undefined))]);
  return Response.json({ key, submission, verdict: verdict ?? "pending" }, { status: verdict ? 200 : 202 });
}
