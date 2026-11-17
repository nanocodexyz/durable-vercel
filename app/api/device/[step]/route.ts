import { device } from "nanocode-ts/machines/server";

export async function POST(request: Request, context: { params: Promise<{ step: string }> }) {
  return device(request, (await context.params).step);
}
