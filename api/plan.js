import { readFile } from "node:fs/promises";
import { parseCsv, validateBatch } from "../lib/actions.js";
import { plan } from "../lib/batch.js";

// GET  /api/plan?example=payroll|vendors[&engine=…&policy=…&approve=…]   plan a shipped batch, live on Pharos Pacific
// POST /api/plan  { from, engine?, policy?, approve?, actions:[{to,amount,token?,label?}] }  or  { from, csv:"to,amount\n…" }
// Read-only: pre-flight, failure policy, what the wallet would sign, gas measured on chain. Nothing is signed or sent.
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const MAX_BODY = 32 * 1024;

async function body(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body; // Vercel parses JSON
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error("the batch is too large (32 KB max)");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function example(name) {
  if (name === "vendors") return { from: "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d", engine: "eip3009", actions: parseCsv(await readFile(new URL("../batches/vendors.csv", import.meta.url), "utf8")) };
  if (name === "payroll") return JSON.parse(await readFile(new URL("../batches/payroll.json", import.meta.url), "utf8"));
  throw new Error("example must be payroll or vendors");
}

export default async function handler(req, res) {
  const send = (status, b) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(json(b));
  const url = new URL(req.url, "http://x");
  let batch;
  try {
    let raw;
    if (req.method === "POST") {
      try {
        raw = await body(req);
      } catch (e) {
        throw new Error(/too large/.test(e.message) ? e.message : "the request body is not valid JSON");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("send a JSON object: { from, actions:[…] }");
      if (typeof raw.csv === "string") raw = { ...raw, actions: parseCsv(raw.csv) };
    } else if (req.method === "GET") {
      raw = await example(url.searchParams.get("example") ?? "payroll");
      for (const k of ["engine", "policy", "approve"]) if (url.searchParams.get(k)) raw = { ...raw, [k]: url.searchParams.get(k) };
    } else return send(405, { ok: false, error: "GET or POST" });
    batch = validateBatch({ from: raw.from, engine: raw.engine, policy: raw.policy, approve: raw.approve, actions: raw.actions });
  } catch (e) {
    return send(400, { ok: false, error: e.message });
  }
  try {
    return send(200, { ok: true, network: "Pharos Pacific Mainnet", batch, plan: await plan(batch) });
  } catch (e) {
    const busy = /timeout|ECONN|fetch failed|unreachable|429|rate/i.test(e.message);
    return send(busy ? 503 : 500, { ok: false, error: busy ? "The Pharos Pacific RPC is not answering right now. Try again in a minute." : e.message.split("\n")[0] });
  }
}
