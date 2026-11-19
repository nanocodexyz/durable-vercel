<h1 align="center">durable-vercel</h1>

<p align="center">
  <a href="https://nanocode.xyz/vercel">Live Demo</a> · <a href="https://nanocode.xyz/experiments/durable-nanocode-on-vercel">How It Works</a> · <a href="https://nanocode.xyz/docs/guides/vercel">Guide</a>
</p>

[nanocode](https://nanocode.xyz) agents in Vercel Functions: one Workflow run per session, with every write to the agent's journal recorded as a step of the run. A template and the source of [nanocode.xyz/vercel](https://nanocode.xyz/vercel).

<p align="center">
  <img alt="A Function appends each journal write to the Workflow run, and when it dies the queue starts another that replays the run" src="assets/workflow.svg" />
</p>

- **Durable.** A Function holds the journal in memory and appends each write to the run with [durable-harness](https://www.npmjs.com/package/durable-harness). When it dies mid-turn, the queue starts another that replays the log and finishes the turn.
- **No sandbox.** Code Mode cells run beside the agent in the Function: bash on a workspace kept in the same journal, git, Python and WebAssembly.
- **One module.** The runtime is [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts), the Rust SDK compiled to WebAssembly. This repository holds the Next.js app around it.

## Run It

```sh
npm install
npm run dev       # next dev, at http://localhost:3000
npm run drill     # Kill a turn midway and check that it resumes
npx vercel deploy # Deploy to a Vercel project
```

## Board

`/board` shows agents coordinating over a shared board, nanocode-board's Rust core compiled to WebAssembly in `board/` and kept in a board session's SQL journal the same way a session keeps its own state: every committed SQL batch is a `nanocode.sql` step of the session's Workflow run. Each write is one keyed submission, and the board settles a key once, so a write sent again after a crash or a redelivered webhook lands in the same row.

- `POST /api/board` with `{"action":"start"}` charters a new board, `{"action":"plan","board":…}` has a lead post a plan with dependencies and starts three workers that claim, split, renew and finish its tasks, and `{"action":"crew","board":…}` adds three more workers.
- `POST /api/board/webhook?board=…` takes GitHub `issues` and `issue_comment` events, keyed by `X-GitHub-Delivery` and checked against `BOARD_WEBHOOK_SECRET` when it is set, as tasks under `github/`, replies and cancels.
- `GET /api/board/stream?board=…` streams the board's log as server-sent events from a cursor (`Last-Event-ID` or `after`).

```sh
npm run board:wasm   # Rebuild lib/board/board.wasm from board/ (Rust with wasm32-unknown-unknown)
npm run board:drill  # SIGKILL a crew mid-plan, restart it, check every task settles once
```

`board/Cargo.toml` takes nanocode-board from a local nanocode checkout by path until the board lands on nanocode's main branch, when it moves to a git pin.

`DECISIONS.md` records what each change established, with its measurements.

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
