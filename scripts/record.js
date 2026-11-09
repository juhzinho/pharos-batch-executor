// Records the demo's mainnet plans (read-only: pre-flight, failure policy, gas measured on Pacific) → public/runs/.
import { readFile, writeFile } from "node:fs/promises";
import { parseCsv, validateBatch } from "../lib/actions.js";
import { plan } from "../lib/batch.js";

const json = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const W = "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d";
const payroll = JSON.parse(await readFile(new URL("../batches/payroll.json", import.meta.url), "utf8"));
const vendors = parseCsv(await readFile(new URL("../batches/vendors.csv", import.meta.url), "utf8"));
const runs = {
  "plan-permit2": validateBatch(payroll),
  "plan-all-or-nothing": validateBatch({ ...payroll, policy: "all-or-nothing" }),
  "plan-eip3009": validateBatch({ from: W, engine: "eip3009", actions: vendors }),
};
for (const [name, batch] of Object.entries(runs)) {
  const p = await plan(batch);
  await writeFile(new URL(`../public/runs/${name}.json`, import.meta.url), json({ recordedAt: new Date().toISOString(), network: "Pharos Pacific Mainnet", batch, plan: p }));
  console.log(`${name}: ${p.outcome} — ${p.summary}${p.gas ? ` · batch ${p.gas.batch.gas} vs one-by-one ${p.gas.individual.gas} (${p.gas.saving.pct.toFixed(1)}%)` : ""}`);
}

// How the saving grows with the size of the batch: the same kind of USDC payroll, N = 3 … 100, both engines.
const points = [];
for (const n of [3, 5, 10, 25, 50, 100]) {
  const actions = Array.from({ length: n }, (_, i) => ({ to: `0x${(i + 1).toString(16).padStart(40, "a")}`, amount: `1.${String(i).padStart(2, "0")}` }));
  const p = await plan(validateBatch({ from: W, engine: "permit2", actions }));
  const g = p.gas;
  points.push({ n, block: p.block.number, individual: g.individual.gas, permit2: g.batch.gas, eip3009: g.other?.gas ?? null });
  console.log(`scaling n=${n}: one by one ${g.individual.gas} · permit2 ${g.batch.gas} (${g.saving.pct.toFixed(1)}%) · eip3009 ${g.other?.gas}`);
}
await writeFile(new URL("../public/runs/scaling.json", import.meta.url), json({ recordedAt: new Date().toISOString(), network: "Pharos Pacific Mainnet", from: W, token: "USDC", note: "recipients 0xaaaa…0001 onwards; amounts 1.00, 1.01, …; gas from eth_estimateGas at each plan's block", points }));
process.exit(0);
