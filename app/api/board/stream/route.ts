import { board } from "@/lib/board/agent";

export const maxDuration = 300;

const encoder = new TextEncoder();

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("board");
  if (!id) return Response.json({ error: "board is required" }, { status: 400 });
  let cursor = Number(request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0;
  const client = board(id);
  const until = Date.now() + 280_000;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = "";
      try {
        while (!request.signal.aborted && Date.now() < until) {
          const { view, entries } = await client.snapshot(cursor);
          for (const entry of entries) {
            controller.enqueue(encoder.encode("id: " + entry.seq + "\nevent: entry\ndata: " + JSON.stringify(entry) + "\n\n"));
            cursor = entry.seq;
          }
          const shown = JSON.stringify(view.tasks);
          if (shown !== last) {
            controller.enqueue(encoder.encode("event: view\ndata: " + JSON.stringify({ ...view, cursor }) + "\n\n"));
            last = shown;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        controller.enqueue(encoder.encode("event: failure\ndata: " + JSON.stringify(String(error)) + "\n\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
