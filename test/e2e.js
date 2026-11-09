// End-to-end, live on Pharos Pacific Mainnet (read-only: nothing is signed by the agent and nothing is sent).
//   node test/e2e.js           mainnet checks (~1–2 min)
//   node test/e2e.js --fork    + the full send-and-verify loop on an Anvil fork (scripts/fork-proof.js)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { maxUint256, parseAbiItem, decodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseCsv, validateBatch } from "../lib/actions.js";
import { assemble, plan } from "../lib/batch.js";
import { verifyBatch } from "../lib/verify.js";
import { makeClient } from "../lib/chain.js";
import { eip3009TypedData, permit2TypedData } from "../lib/engines.js";
import { ABI, MULTICALL3, PERMIT2, TOKENS } from "../lib/contracts.js";
import handler from "../api/plan.js";

const read = async (p) => readFile(new URL(p, import.meta.url), "utf8");
const payroll = JSON.parse(await read("../batches/payroll.json"));
const vendors = { from: payroll.from, engine: "eip3009", actions: parseCsv(await read("../batches/vendors.csv")) };
const client = makeClient();
const R = (n) => `0x${String(n).repeat(40)}`;
let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n   ${e.message}`);
  }
}

await check("permit2, skip-failed: 5 actions, the typo is left out with its reason, 4 go into one signed message", async () => {
  const p = await plan(validateBatch(payroll), { client });
  assert.equal(p.outcome, "partial");
  assert.deepEqual(p.actions.map((a) => a.ok), [true, true, false, true, true]);
  assert.match(p.actions[2].reason, /insufficient USDC: .* left after the actions before it, 999,999 needed/);
  assert.deepEqual(p.batchActions, [1, 2, 4, 5]);
  assert.equal(p.sign.kind, "permit2");
  assert.equal(p.sign.typedData.message.permitted.length, 4);
  assert.equal(p.sign.typedData.domain.verifyingContract, PERMIT2);
  // gas measured both ways on chain; the batch is cheaper; the one-time approval is accounted for honestly
  const g = p.gas;
  assert.equal(g.individual.perAction.length, 4);
  assert.ok(BigInt(g.batch.gas) < BigInt(g.individual.gas), `${g.batch.gas} vs ${g.individual.gas}`);
  assert.ok(g.saving.pct > 5 && g.saving.pct < 40, String(g.saving.pct));
  assert.equal(g.approval.mode, "standing");
  assert.equal(BigInt(g.approval.firstBatchTotal), BigInt(g.batch.gas) + BigInt(g.approval.gas));
  assert.equal(g.approval.breakEvenBatch, Number(BigInt(g.approval.gas) / BigInt(g.saving.gas)) + 1);
  // standing approvals: one per token, max allowance to Permit2, prepared unsigned with nonces in order
  assert.equal(p.approvals.length, 2);
  for (const [i, a] of p.approvals.entries()) {
    const d = decodeFunctionData({ abi: ABI.erc20, data: a.tx.data });
    assert.deepEqual(d.args, [PERMIT2, maxUint256]);
    assert.equal(BigInt(a.tx.nonce), BigInt(p.nextNonce - 2 + i));
  }
});

await check("approve exact: sized to this batch, and the report says every batch needs its own", async () => {
  const p = await plan(validateBatch({ ...payroll, approve: "exact" }), { client });
  const usdc = p.approvals.find((a) => a.tx.to === TOKENS.USDC.address);
  assert.equal(decodeFunctionData({ abi: ABI.erc20, data: usdc.tx.data }).args[1], 4_450_500_000n, "1200 + 850.5 + 2400 USDC");
  assert.equal(p.gas.approval.mode, "exact");
  assert.equal(p.gas.approval.breakEvenBatch, null);
});

await check("all-or-nothing: one failing action refuses the whole batch — nothing to sign, nothing moves", async () => {
  const p = await plan(validateBatch({ ...payroll, policy: "all-or-nothing" }), { client });
  assert.equal(p.outcome, "refused");
  assert.match(p.summary, /action 3 would fail/);
  assert.equal(p.sign, undefined);
  assert.equal(p.gas, undefined);
});

await check("eip3009 + Multicall3: 4 authorizations, and the report says plainly it costs more gas than one by one", async () => {
  const p = await plan(validateBatch(vendors), { client });
  assert.equal(p.outcome, "ready");
  assert.equal(p.sign.kind, "eip3009");
  assert.equal(p.sign.typedData.length, 4);
  assert.equal(new Set(p.sign.typedData.map((t) => t.message.nonce)).size, 4);
  assert.ok(p.gas.saving.pct < 0, "EIP-3009 verifies a signature per transfer");
  assert.equal(p.gas.other.engine, "permit2");
  assert.ok(p.gas.other.vsIndividualPct > 0, "and permit2 would have saved gas");
  assert.equal(p.approvals.length, 0);
});

await check("a wallet without PROS for gas gets a plain warning (permit2: the wallet itself sends the batch)", async () => {
  const noPros = new Proxy(client, { get: (c, k) => (k === "getBalance" ? async () => 0n : c[k]) });
  const p = await plan(validateBatch(payroll), { client: noPros });
  assert.equal(p.outcome, "partial");
  assert.match(p.warnings.at(-1), /^the wallet holds 0 PROS; sending the approvals and the batch needs up to [\d.,]+ PROS for gas$/);
  const q = await plan(validateBatch(vendors), { client: noPros });
  assert.match(q.warnings.at(-1), /any funded account can send the batch/);
});

await check("a wallet with code is blocked (its signatures would go through EIP-1271)", async () => {
  const p = await plan(validateBatch({ ...vendors, from: TOKENS.USDC.address }), { client });
  assert.equal(p.outcome, "blocked");
  assert.match(p.blockers[0], /contract/);
});

// assemble: a test signer stands in for the wallet; its balances are applied by state override and reported.
const twin = privateKeyToAccount(generatePrivateKey());
const twinActions = [{ to: R(1), amount: "100" }, { to: R(2), amount: "250.5" }, { to: R(3), amount: "75" }];

await check("assemble permit2: the one transaction, simulated on mainnet state — every transfer goes through", async () => {
  const batch = validateBatch({ from: twin.address, engine: "permit2", actions: twinActions });
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const typed = permit2TypedData(batch.from, batch.actions, { deadline });
  const planned = { batchActions: [1, 2, 3], sign: { kind: "permit2", typedData: JSON.parse(JSON.stringify(typed, (_, v) => (typeof v === "bigint" ? v.toString() : v))) }, approvals: [{ tx: { to: TOKENS.USDC.address } }], nextNonce: 0, gas: { batch: { gas: "200000" } } };
  const a = await assemble(batch, planned, await twin.signTypedData(typed), { client, extraOverride: { [TOKENS.USDC.address]: 10_000n * 10n ** 6n } });
  assert.ok(a.simulation.ok, JSON.stringify(a.simulation));
  assert.deepEqual(a.simulation.overrides, ["the pending Permit2 approval", "test balances"]);
  assert.equal(a.tx.tx.to, PERMIT2);
  assert.equal(a.tx.tx.chainId, 1672);
});

await check("assemble permit2 with too little balance: the whole batch reverts and every action says so", async () => {
  const batch = validateBatch({ from: twin.address, engine: "permit2", actions: twinActions });
  const typed = permit2TypedData(batch.from, batch.actions, { deadline: Math.floor(Date.now() / 1000) + 3600 });
  const planned = { batchActions: [1, 2, 3], sign: { kind: "permit2", typedData: JSON.parse(JSON.stringify(typed, (_, v) => (typeof v === "bigint" ? v.toString() : v))) }, approvals: [{ tx: { to: TOKENS.USDC.address } }], nextNonce: 0, gas: { batch: { gas: "200000" } } };
  const a = await assemble(batch, planned, await twin.signTypedData(typed), { client, extraOverride: { [TOKENS.USDC.address]: 200n * 10n ** 6n } });
  assert.equal(a.simulation.ok, false);
  assert.match(a.simulation.reason, /TRANSFER_FROM_FAILED/);
  assert.ok(a.simulation.actions.every((x) => !x.success && /whole batch reverts/.test(x.reason)));
});

await check("assemble eip3009, skip-failed: one transfer does not fit — only that one fails, with the token's reason", async () => {
  const batch = validateBatch({ from: twin.address, engine: "eip3009", actions: twinActions });
  const typeds = eip3009TypedData(batch.from, batch.actions, { validBefore: Math.floor(Date.now() / 1000) + 3600 });
  const sigs = await Promise.all(typeds.map((t) => twin.signTypedData(t)));
  const planned = { batchActions: [1, 2, 3], sign: { kind: "eip3009", typedData: JSON.parse(JSON.stringify(typeds, (_, v) => (typeof v === "bigint" ? v.toString() : v))) }, approvals: [], nextNonce: 0, gas: { batch: { gas: "300000" } } };
  // 300 USDC: #1 (100) fits, #2 (250.5) no longer fits, #3 (75) still fits
  const a = await assemble(batch, planned, sigs, { client, extraOverride: { [TOKENS.USDC.address]: 300n * 10n ** 6n } });
  assert.equal(a.tx.tx.to, MULTICALL3);
  assert.deepEqual(a.simulation.actions.map((x) => x.success), [true, false, true]);
  assert.match(a.simulation.actions[1].reason, /transfer amount exceeds balance/);
});

await check("verify reads a real Pacific receipt: a transfer that is there is found, one that is not is reported", async () => {
  const head = await client.getBlockNumber();
  let log;
  for (let to = head; !log && to > head - 20_000n; to -= 1_000n) {
    // the Pacific RPC serves eth_getLogs over at most 1,000 blocks
    const logs = await client.getLogs({ address: TOKENS.USDC.address, event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), fromBlock: to - 999n, toBlock: to });
    log = logs.find((l) => l.args.value > 0n && l.args.from !== "0x0000000000000000000000000000000000000000");
  }
  assert.ok(log, "a USDC transfer in the last 20,000 blocks");
  const { from, to, value } = log.args;
  const v = await verifyBatch(client, { hash: log.transactionHash, from, engine: "permit2", actions: [
    { index: 1, to, amount: value.toString(), tokenAddress: TOKENS.USDC.address },
    { index: 2, to, amount: (value + 1n).toString(), tokenAddress: TOKENS.USDC.address },
  ] });
  assert.equal(v.status, "success");
  assert.deepEqual(v.actions.map((a) => a.executed), [true, false]);
  assert.ok(v.actions[1].reason);
  assert.match(v.summary, /1 of 2 transfers happened/);
});

// the CLI and the API, as a user meets them
const cli = (...args) => spawnSync(process.execPath, ["tasks/batch/batch.js", ...args], { encoding: "utf8", cwd: new URL("..", import.meta.url) });

await check("CLI: plan prints the ledger and the gas report, exit 0; refused exits 3; mistakes exit 2", async () => {
  const ok = cli("plan", "batches/payroll.json", "--out", "scratch/e2e-plan.json");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PARTIAL/);
  assert.match(ok.stdout, /saves [\d,]+ gas/);
  assert.match(ok.stdout, /Then sign {2}one EIP-712 message/);
  assert.equal(cli("plan", "batches/payroll.json", "--policy", "all-or-nothing", "--out", "scratch/e2e-aon.json").status, 3);
  const csv = cli("plan", "batches/vendors.csv", "--from", payroll.from, "--engine", "eip3009", "--out", "scratch/e2e-csv.json");
  assert.equal(csv.status, 0, csv.stderr);
  assert.match(csv.stdout, /costs [\d,]+ gas more/);
  // a wrong signature: the simulation shows the revert and no transaction is handed over
  const wrong = cli("assemble", "scratch/e2e-plan.json", "--sig", `0x${"ab".repeat(65)}`);
  assert.equal(wrong.status, 3, wrong.stderr);
  assert.match(wrong.stdout, /InvalidSignature\(\)/);
  assert.match(wrong.stdout, /Not handing over a transaction/);
  assert.ok(!wrong.stdout.includes("unsignedTransaction"));
  for (const bad of [[], ["plan", "nope.json"], ["plan", "batches/vendors.csv"], ["plan", "batches/payroll.json", "--engine", "magic"], ["plan", "batches/payroll.json", "--bogus", "1"], ["assemble", "scratch/e2e-plan.json"], ["assemble", "scratch/e2e-plan.json", "--sig", "0x12"], ["assemble", "scratch/e2e-plan.json", "--sig", `0x${"1".repeat(130)}`, "--sig", `0x${"2".repeat(130)}`], ["assemble", "scratch/e2e-aon.json", "--sig", `0x${"1".repeat(130)}`], ["assemble", "batches/payroll.json", "--sig", `0x${"1".repeat(130)}`], ["verify", "scratch/e2e-plan.json", "--tx", "0x1"], ["launch", "x"]]) {
    const r = cli(...bad);
    assert.equal(r.status, 2, `${bad.join(" ")} → ${r.status}: ${r.stderr}`);
    assert.ok(!/at .*\.js:\d+/.test(r.stderr), "no stack trace");
  }
});

async function api(method, path, body) {
  const req = Object.assign(async function* () {}(), { method, url: path, body });
  return new Promise((resolve) => {
    const res = { writeHead: (status) => ({ end: (s) => resolve({ status, json: JSON.parse(s) }) }) };
    handler(req, res);
  });
}
await check("API: plans a shipped example live, plans a posted CSV, and rejects bad input with 400", async () => {
  const a = await api("GET", "/api/plan?example=payroll&policy=all-or-nothing");
  assert.equal(a.status, 200);
  assert.equal(a.json.plan.outcome, "refused");
  const b = await api("POST", "/api/plan", { from: payroll.from, csv: "to,amount\n0x6666666666666666666666666666666666666666,1\n0x7777777777777777777777777777777777777777,2\n0x8888888888888888888888888888888888888888,3" });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.plan.outcome, "ready");
  for (const [m, p, body] of [["GET", "/api/plan?example=nope"], ["POST", "/api/plan", { from: payroll.from, actions: [] }], ["POST", "/api/plan", [1, 2]], ["POST", "/api/plan", { from: "0x1", csv: "to,amount\n" }], ["DELETE", "/api/plan"]]) {
    const r = await api(m, p, body);
    assert.ok(r.status === 400 || r.status === 405, `${m} ${p} → ${r.status}`);
    assert.equal(r.json.ok, false);
  }
});

if (process.argv.includes("--fork")) {
  await check("fork: sign, send and verify all three scenarios (A gas, B partial failure, C atomic revert + re-plan)", async () => {
    const r = spawnSync(process.execPath, ["scripts/fork-proof.js"], { encoding: "utf8", cwd: new URL("..", import.meta.url), timeout: 600_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /All 5 transfers happened/);
    assert.match(r.stdout, /3 of 5 transfers happened/);
    assert.match(r.stdout, /none of the 4 transfers happened/);
    assert.match(r.stdout, /All 3 transfers happened/);
  });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
