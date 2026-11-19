"use client";

import { useEffect, useState } from "react";
import { href } from "@/lib/base";
import type { Entry, Task, View } from "@/lib/board/core";

const colors: Record<string, string> = { open: "#888", claimed: "#e0b341", done: "#58c26b", failed: "#e05a4f", cancelled: "#666" };

export default function BoardPage() {
  const [board, setBoard] = useState<string>();
  const [view, setView] = useState<View>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(location.search).get("board");
    if (id) setBoard(id);
  }, []);

  useEffect(() => {
    if (!board) return;
    setEntries([]);
    const source = new EventSource(href("/api/board/stream") + "?board=" + encodeURIComponent(board));
    source.addEventListener("entry", event => setEntries(list => [...list, JSON.parse((event as MessageEvent).data) as Entry].slice(-200)));
    source.addEventListener("view", event => setView(JSON.parse((event as MessageEvent).data) as View));
    return () => source.close();
  }, [board]);

  const post = async (body: object) => {
    setBusy(true);
    try {
      return (await (await fetch(href("/api/board"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { board?: string };
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const { board: id } = await post({ action: "start" });
    if (!id) return;
    history.replaceState(null, "", "?board=" + id);
    setBoard(id);
  };

  const tasks: Task[] = view?.tasks ?? [];
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18 }}>Board on Vercel Workflow</h1>
      <p style={{ color: "#aaa", fontSize: 13 }}>A lead posts a plan with dependencies, workers claim and finish tasks, GitHub webhooks land as tasks and replies once, and this page follows the board's log by cursor.</p>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <button disabled={busy} onClick={start}>New board</button>
        <button disabled={busy || !board} onClick={() => post({ action: "plan", board })}>Post a plan + 3 workers</button>
        <button disabled={busy || !board} onClick={() => post({ action: "crew", board })}>Add 3 workers</button>
        {board && <code style={{ alignSelf: "center", color: "#aaa" }}>{board} · cursor {view && entries.at(-1)?.seq}</code>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <section>
          <h2 style={{ fontSize: 14 }}>Tasks ({tasks.filter(task => task.phase.state === "done").length}/{tasks.length} done)</h2>
          {tasks.map(task => (
            <div key={task.id} style={{ borderLeft: "3px solid " + colors[task.phase.state], padding: "4px 8px", margin: "6px 0", marginLeft: task.parent ? 20 : 0, fontSize: 12 }}>
              <div><b>{task.id}</b> <span style={{ color: colors[task.phase.state] }}>{task.phase.state}</span>{task.phase.state === "claimed" && " by " + task.phase.worker} {task.needs.length > 0 && <span style={{ color: "#777" }}>needs {task.needs.join(", ")}</span>}</div>
              <div style={{ color: "#aaa" }}>{task.spec}</div>
              {task.phase.state === "done" && <div style={{ color: "#7a7" }}>{task.phase.result}</div>}
              {task.replies.map((reply, i) => <div key={i} style={{ color: "#99c" }}>↳ {reply.body}</div>)}
            </div>
          ))}
        </section>
        <section>
          <h2 style={{ fontSize: 14 }}>Log</h2>
          {entries.slice().reverse().map(entry => (
            <div key={entry.seq + ":" + entry.task + ":" + entry.change.kind} style={{ fontSize: 11, color: "#bbb" }}>
              #{entry.seq} {entry.task} {entry.change.kind}{entry.change.kind === "claimed" ? " by " + entry.change.worker + (entry.change.took_over ? " (took over)" : "") : ""}
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
