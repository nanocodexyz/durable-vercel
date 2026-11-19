import { waitUntil } from "@vercel/functions";
import { agent, authorized, board } from "@/lib/board/agent";
import { charter, crew, lead } from "@/lib/board/crew";

export const maxDuration = 300;

const names = (count: number) => Array.from({ length: Math.min(Math.max(count, 1), 6) }, () => "agent:worker-" + crypto.randomUUID().slice(0, 4));

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("board");
  if (!id) return Response.json({ error: "board is required" }, { status: 400 });
  return Response.json(await board(id).view());
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return new Response("unauthorized", { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; board?: string; plan?: string; workers?: number };
  if (body.action === "start") {
    const id = (await agent.sessions.start()).sessionId;
    return Response.json({ board: id, charter: await charter(board(id)) });
  }
  if (!body.board) return Response.json({ error: "board is required" }, { status: 400 });
  const client = board(body.board);
  const workers = names(body.workers ?? 3);
  if (body.action === "plan") {
    const plan = body.plan ?? "plan-" + crypto.randomUUID().slice(0, 6);
    const posted = await lead(client, plan);
    waitUntil(crew(client, workers, { report: report => console.log(JSON.stringify({ crew: report })) }));
    return Response.json({ plan, posted, workers });
  }
  if (body.action === "crew") {
    waitUntil(crew(client, workers, { report: report => console.log(JSON.stringify({ crew: report })) }));
    return Response.json({ workers });
  }
  return Response.json({ error: "action is start, plan or crew" }, { status: 400 });
}
