export function GET(): Response {
  return Response.json({
    commit: process.env.NANOCODE_COMMIT,
    nanocodeTs: process.env.NANOCODE_TS_RELEASE,
    wasmSha256: process.env.NANOCODE_WASM_SHA256,
  }, { headers: { "Cache-Control": "no-store" } });
}
