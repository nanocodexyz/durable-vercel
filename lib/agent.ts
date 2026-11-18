import type { HostTool } from "durable-harness";
import { getCache, upgradeWebSocket } from "@vercel/functions";
import { Wallets } from "nanocode-ts/machines/vercel";
import * as Account from "nanocode-ts/machines/server";
import { PythonSci } from "nanocode-ts/bash";
import { App, Listings } from "nanocode-ts/vercel";
import { href } from "./base.ts";
import { defaultSelection, harnesses, planHarnesses } from "./settings.ts";
import { type Charge, chargeTool } from "./tools.ts";

export const appTools = (record: (charge: Charge) => Promise<void> | void): HostTool[] => [chargeTool(record)];

const HAND_INSTRUCTIONS = "This session's Code Mode cells run on the visitor's own computer, which they connected with `nc hand`: the tools in your scripts act on their real files and shell, starting in the folder they ran it from. Work in that folder unless they ask otherwise, tell them what you will run before anything that changes their system, and never delete their files, install software, use their credentials or send their data anywhere unless they ask you to.";

const token = process.env.CHAT_TOKEN;

const isPublic = !token && process.env.CHAT_PUBLIC === "1";

const directDriveMs = 280_000;

const hex = (name: string): `0x${string}` | undefined => {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${name} is not a 0x-prefixed hex string`);
  return value as `0x${string}`;
};

const sponsorKey = hex("TEMPO_SPONSOR_KEY");

const sponsor = sponsorKey && {
  key: sponsorKey,
  account: hex("TEMPO_SPONSOR_ACCOUNT"),
  allowance: { budget: "0.05", calls: 10, windowMs: 3_600_000 },
  deposit: { opening: "0.01", topUp: "0.01", maximum: "0.05" },
};

const authorize = (request: Request) => {
  if (token && request.headers.get("authorization") !== `Bearer ${token}`) throw new Response("unauthorized", { status: 401 });
};

export const wallets = Wallets.create({
  sessions: () => nanocode.agent.sessions,
  secret: process.env.KEY_SECRET,
  authorize: request => {
    if (!token && !isPublic && process.env.NODE_ENV === "production") throw new Response("set CHAT_TOKEN or CHAT_PUBLIC=1", { status: 401 });
    authorize(request);
  },
  kv: true,
  scripts: true,
  sponsor,
  ...(process.env.TEMPO_RPC ? { rpc: process.env.TEMPO_RPC } : {}),
});

export const nanocode = App.create({
  account: request => Account.visitor(request),
  plans: { prefix: href("/api/plans") },
  harnesses,
  payerHarnesses: { plan: planHarnesses },
  wallet: wallets.model,
  defaultSelection,
  tools: appTools(charge => console.log(JSON.stringify({ charge }))),
  report: drive => console.log(JSON.stringify({ drive })),
  sessionFetch: wallets.fetch,
  promptImages: session => /^(?:claude-|gpt-)/.test(session.model ?? ""),
  hands: { upgrade: upgradeWebSocket, name: "machine" },
  handInstructions: HAND_INSTRUCTIONS,
  durability: process.env.NANOCODE_DURABILITY === "strict" ? "strict" : "on",
  directDriveMs,
  marks: process.env.HARNESS_MARKS === "1",
  chaos: process.env.HARNESS_CHAOS === "1",
  authorize: token ? authorize : isPublic ? "public" : undefined,
  mcp: { ...wallets.mcp, failureMs: directDriveMs, store: Listings.store(getCache({ namespace: "nanocode-mcp" })) },
  ...(isPublic ? { maxPrompts: 20, maxPromptCharacters: 2000 } : {}),
  warmDriveMs: directDriveMs,
  workspace: { python: { sci: PythonSci.local() } },
});

export const agent = nanocode.agent;