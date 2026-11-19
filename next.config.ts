import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import { withDurableHarness } from "durable-harness/next";
import { zyzz } from "zyzz/next";
import { basePath } from "./lib/base.ts";

const revision = process.env.NANOCODE_COMMIT === undefined ? spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }) : undefined;
const commit = process.env.NANOCODE_COMMIT ?? (revision?.status === 0 ? revision.stdout.trim() : undefined);
if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) throw new Error("NANOCODE_COMMIT must be a full 40-character commit; supply it when Git is unavailable");

const config: NextConfig = {
  assetPrefix: basePath,
  env: { NANOCODE_COMMIT: commit, NANOCODE_TS_RELEASE: JSON.parse(readFileSync("package.json", "utf8")).dependencies["nanocode-ts"], NANOCODE_WASM_SHA256: createHash("sha256").update(readFileSync("node_modules/nanocode-ts/dist/nanocode_wasm.wasm")).digest("hex"), NANOCODE_WASM_HASH: createHash("sha256").update(readFileSync("node_modules/nanocode-ts/dist/nanocode_wasm.wasm")).digest("hex").slice(0, 20) },
  outputFileTracingIncludes: { "/.well-known/workflow/v1/flow": ["./node_modules/nanocode-ts/dist/nanocode_wasm.wasm", "./lib/board/board.wasm"], "/api/chat": ["./node_modules/nanocode-ts/dist/nanocode_wasm.wasm"], ...Object.fromEntries(["/api/board", "/api/board/stream", "/api/board/webhook"].map(route => [route, ["./lib/board/board.wasm"]])) },
  redirects: async () => [
    { destination: basePath, permanent: false, source: "/" },
    { destination: "https://nanocode.xyz/experiments/durable-nanocode-on-vercel", permanent: true, source: `${basePath}/how-it-works` },
    ...["/chatgpt", "/claude"].map(path => ({ destination: path, missing: [{ key: "x-nanocode-proxy", type: "header" as const }], permanent: true, source: `${basePath}${path}` })),
  ],
  rewrites: async () => [
    { destination: "/", missing: [{ key: "theme", type: "query" }], source: basePath },
    { destination: "/", has: [{ key: "theme", type: "query", value: "nanocode" }], source: basePath },
    { destination: "/chatgpt", has: [{ key: "theme", type: "query", value: "codex" }], source: basePath },
    { destination: "/claude", has: [{ key: "theme", type: "query", value: "claude" }], source: basePath },
    { destination: "/themes/unknown", has: [{ key: "theme", type: "query" }], source: basePath },
    { destination: "/:path*", source: `${basePath}/:path*` },
  ],
};

export default zyzz(withDurableHarness(config, { agents: ["lib/agent.ts", "lib/board/agent.ts"] }));
