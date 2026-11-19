import { durableAgent } from "durable-harness";
import { client } from "./client.ts";
import * as Board from "./harness.ts";

export const agent = durableAgent({
  harness: Board.create({ durability: process.env.NANOCODE_DURABILITY === "strict" ? "strict" : "on", report: report => console.log(JSON.stringify({ board: report })) }),
  durability: process.env.NANOCODE_DURABILITY === "strict" ? "strict" : "on",
});

export const board = (id: string) => client(agent.sessions, id);

export const authorized = (request: Request) => {
  const token = process.env.CHAT_TOKEN;
  return !token || request.headers.get("authorization") === "Bearer " + token;
};
