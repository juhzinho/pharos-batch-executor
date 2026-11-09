#!/usr/bin/env node
// Batch Executor for Pharos Pacific: several independent token transfers as ONE transaction.
//   npm run batch -- plan batches/payroll.json                 pre-flight, failure policy, what to sign, gas report
//   npm run batch -- plan batches/vendors.csv --from 0x… --engine eip3009 --policy all-or-nothing
//   npm run batch -- assemble .batch/plan.json --sig 0x…       the single unsigned transaction, simulated per action
//   npm run batch -- verify .batch/plan.json --tx 0x…          after sending: which actions happened, which did not, why
//   npm run batch -- demo                                      the full loop on an Anvil fork (test wallets)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parseCsv, validateBatch } from "../../lib/actions.js";
import { assemble, plan } from "../../lib/batch.js";
import { verifyBatch } from "../../lib/verify.js";
import { makeClient } from "../../lib/chain.js";
import { renderAssembled, renderPlan, renderVerify } from "../../lib/render.js";

const USAGE = `usage: npm run batch -- plan <batch.json|.csv> [--from 0x…] [--engine permit2|eip3009] [--policy skip-failed|all-or-nothing] [--approve standing|exact] [--out .batch/plan.json]
       npm run batch -- assemble <plan.json> --sig 0x… [--sig 0x…]…
       npm run batch -- verify <plan.json> --tx 0x…
       npm run batch -- demo
Nothing is ever signed by this tool: the wallet signs the EIP-712 message(s) in the plan; the batch comes back unsigned.`;

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(USAGE);
  process.exit(cmd ? 0 : 2);
}
const flags = { sig: [] };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  if (!rest[i].startsWith("--")) {
    console.error(`unexpected argument "${rest[i]}"\n${USAGE}`);
    process.exit(2);
  }
  const v = rest[i + 1];
  if (v == null || v.startsWith("--")) {
    console.error(`--${k} needs a value`);
    process.exit(2);
  }
  i++;
  if (k === "sig") flags.sig.push(v);
  else if (["from", "engine", "policy", "approve", "out", "tx"].includes(k)) flags[k] = v;
  else {
    console.error(`unknown flag --${k}\n${USAGE}`);
    process.exit(2);
  }
}
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
/** A mistake in what the user passed (exit 2), as opposed to the chain or the RPC failing (exit 1). */
const usage = (message) => Object.assign(new Error(message), { usage: true });
const asUsage = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw usage(e.message);
  }
};
async function readText(path, what = "file") {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw usage(`${what} not found: ${path}`);
  }
}
async function readBatch(path) {
  const text = await readText(path);
  if (path.endsWith(".csv")) return asUsage(() => validateBatch({ from: flags.from, engine: flags.engine, policy: flags.policy, approve: flags.approve, actions: parseCsv(text) }));
  const raw = asUsage(() => JSON.parse(text));
  return asUsage(() => validateBatch({ ...raw, ...(flags.engine ? { engine: flags.engine } : {}), ...(flags.policy ? { policy: flags.policy } : {}), ...(flags.approve ? { approve: flags.approve } : {}) }, { from: flags.from }));
}

try {
  if (cmd === "demo") {
    execFileSync(process.execPath, ["scripts/fork-proof.js"], { stdio: "inherit" });
    process.exit(0);
  }
  if (!["plan", "assemble", "verify"].includes(cmd)) throw usage(`unknown command “${cmd}”`);
  if (!file) throw usage(`${cmd} needs a file`);
  if (cmd === "plan") {
    const batch = await readBatch(file);
    const p = await plan(batch);
    const outFile = flags.out ?? ".batch/plan.json";
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, json({ batch, plan: p }));
    console.log(renderPlan(p));
    console.log(`\n  plan written to ${outFile}`);
    process.exit(["ready", "partial"].includes(p.outcome) ? 0 : 3);
  }
  const fileText = await readText(file, "plan file");
  const saved = asUsage(() => JSON.parse(fileText));
  if (!saved?.batch?.actions || !saved?.plan) throw usage(`${file} is not a plan file (write one with: npm run batch -- plan <batch>)`);
  if (!saved.plan.sign) throw usage(`this plan was ${saved.plan.outcome}: there is nothing to ${cmd} — ${saved.plan.summary}`);
  const batch = { ...saved.batch, actions: saved.batch.actions.map((a) => ({ ...a, amount: BigInt(a.amount) })) };
  if (cmd === "assemble") {
    if (!flags.sig.length) throw usage("assemble needs the wallet's signature(s): --sig 0x…");
    for (const s of flags.sig) if (!/^0x[0-9a-fA-F]{130}$/.test(s)) throw usage(`--sig ${s.slice(0, 12)}…: a signature is 0x + 130 hex characters`);
    const want = saved.plan.sign.kind === "permit2" ? 1 : saved.plan.batchActions.length;
    if (flags.sig.length !== want) throw usage(`${saved.plan.sign.kind} needs ${want} signature${want > 1 ? "s, one per action in the batch," : ""} (got ${flags.sig.length})`);
    const a = await assemble(batch, saved.plan, flags.sig);
    console.log(renderAssembled(a));
    // a transaction in which nothing would happen is not handed over: sending it would only burn gas
    const going = a.simulation.actions.filter((x) => x.success).length;
    if (!going) {
      const why = /InvalidSigner|InvalidSignature|invalid signature/i.test(a.simulation.reason ?? a.simulation.actions[0]?.reason ?? "") ? " The signature does not match this plan: sign the typed data in this plan file, with the paying wallet." : " Re-plan (the pre-flight re-checks every action) and sign again.";
      console.log(`\n  Not handing over a transaction: none of the ${a.simulation.actions.length} transfers would happen.${why}`);
      process.exit(3);
    }
    if (going < a.simulation.actions.length) console.log(`\n  ${going} of ${a.simulation.actions.length} transfers would happen; the others fail on their own (allowFailure) — see above.`);
    console.log(json({ unsignedTransaction: a.tx.tx }));
    process.exit(0);
  }
  if (cmd === "verify") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(flags.tx ?? "")) throw usage("verify needs --tx <transaction hash>");
    const kept = batch.actions.filter((a) => saved.plan.batchActions.includes(a.index)).map((a) => ({ ...a, amount: a.amount.toString() }));
    console.log(renderVerify(await verifyBatch(makeClient(), { hash: flags.tx, from: batch.from, actions: kept, engine: saved.plan.sign.kind })));
    process.exit(0);
  }
} catch (e) {
  console.error(`error: ${String(e.message).split("\n")[0]}`);
  if (e.usage) console.error(`\n${USAGE}`);
  process.exit(e.usage ? 2 : 1);
}
