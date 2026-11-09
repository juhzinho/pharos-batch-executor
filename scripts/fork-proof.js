// Proof on an Anvil fork of Pharos Pacific, with real receipts. A fresh test key (generated per run, funded only on
// the fork) plays the wallet: it signs and sends exactly what the agent prepared — the agent itself never signs.
//   A  permit2, 5 transfers in 2 tokens: one transaction; actual gas vs the same 5 sent one by one (same state)
//   B  eip3009 + Multicall3, failures AT EXECUTION: after signing, one authorization is cancelled and the wallet
//      spends USDC; the batch runs anyway → 3 transfers happen, 2 do not, each with its reason
//   C  permit2 is atomic: the same kind of change makes the whole transaction revert → nothing moves; the agent
//      re-plans (pre-flight now drops the failing action) and the clean batch goes through
// Writes public/runs/fork-proof.json.
import { writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, encodeFunctionData, http, pad, parseSignature, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startFork } from "../lib/fork.js";
import { ABI, CHAIN_ID, SLOTS, TOKENS, USDC_DOMAIN, mapSlot } from "../lib/contracts.js";

const fork = await startFork({ port: Number(process.env.FORK_PORT ?? 8549) });
process.env.PHAROS_RPC_URL = fork.url;
const { validateBatch } = await import("../lib/actions.js");
const { plan, assemble } = await import("../lib/batch.js");
const { verifyBatch } = await import("../lib/verify.js");
const { makeClient } = await import("../lib/chain.js");

const chain = { id: CHAIN_ID, name: "Pacific fork", nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [fork.url] } } };
const pub = createPublicClient({ chain, transport: http(fork.url, { timeout: 120_000 }) });
const log = (m) => console.log(m);
const rpc = (method, params) => pub.request({ method, params });

/** A fresh wallet funded on the fork only. */
async function freshWallet(usdc, wpros = 0n) {
  const account = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [account.address, "0x56BC75E2D63100000"]); // 100 PROS for gas, fork only
  await rpc("anvil_setStorageAt", [TOKENS.USDC.address, mapSlot(account.address, SLOTS[TOKENS.USDC.address].balance), pad(toHex(usdc))]);
  if (wpros) await rpc("anvil_setStorageAt", [TOKENS.WPROS.address, mapSlot(account.address, SLOTS[TOKENS.WPROS.address].balance), pad(toHex(wpros))]);
  return { account, wallet: createWalletClient({ account, chain, transport: http(fork.url) }) };
}
/** Sends a prepared unsigned transaction exactly as prepared (to, data, gas, fees, nonce). */
async function sendPrepared(w, t) {
  const hash = await w.wallet.sendTransaction({ to: t.tx.to, data: t.tx.data, gas: BigInt(t.tx.gas), maxFeePerGas: BigInt(t.tx.maxFeePerGas), maxPriorityFeePerGas: 0n, nonce: Number(t.tx.nonce) });
  return pub.waitForTransactionReceipt({ hash });
}
async function sign(w, p) {
  const t = p.sign.typedData;
  const revive = (x) => ({ ...x, message: JSON.parse(JSON.stringify(x.message), (k, v) => (typeof v === "string" && /^\d+$/.test(v) && k !== "nonce" ? BigInt(v) : v)) });
  if (p.sign.kind === "permit2") {
    const m = t.message;
    return w.account.signTypedData({ ...t, message: { permitted: m.permitted.map((x) => ({ token: x.token, amount: BigInt(x.amount) })), spender: m.spender, nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) } });
  }
  return Promise.all(t.map((x) => w.account.signTypedData({ ...x, message: { ...x.message, value: BigInt(x.message.value), validAfter: BigInt(x.message.validAfter), validBefore: BigInt(x.message.validBefore) } })));
}
const R = (n) => `0x${String(n).repeat(40)}`;

try {
  const out = {};
  const client = makeClient();

  // ── A ───────────────────────────────────────────────────────────────────────────────────────
  log("A. permit2: 5 transfers (4 USDC + 1 WPROS) in one transaction");
  const wa = await freshWallet(50_000n * 10n ** 6n, 100n * 10n ** 18n);
  const batchA = validateBatch({ from: wa.account.address, engine: "permit2", actions: [
    { to: R(1), amount: "1200", label: "payroll A" }, { to: R(2), amount: "850.5", label: "payroll B" }, { to: R(3), amount: "2400", label: "payroll C" },
    { to: R(4), amount: "310.25", label: "payroll D" }, { to: R(5), amount: "12.5", token: "WPROS", label: "gas top-up E" },
  ] });
  const pa = await plan(batchA, { client });
  for (const ap of pa.approvals) log(`   one-time: ${ap.label} → ${(await sendPrepared(wa, ap)).status}`);
  const snap = await rpc("evm_snapshot", []);
  // the same 5 transfers one by one, from the same state, for the real comparison
  let oneByOne = 0n;
  for (const a of batchA.actions) {
    const hash = await wa.wallet.sendTransaction({ to: a.tokenAddress, data: encodeFunctionData({ abi: ABI.erc20, functionName: "transfer", args: [a.to, a.amount] }) });
    oneByOne += (await pub.waitForTransactionReceipt({ hash })).gasUsed;
  }
  await rpc("evm_revert", [snap]);
  const asmA = await assemble(batchA, { ...pa, nextNonce: pa.nextNonce }, await sign(wa, pa), { client });
  const rcA = await sendPrepared(wa, asmA.tx);
  const vA = await verifyBatch(client, { hash: rcA.transactionHash, from: wa.account.address, actions: batchA.actions.map((a) => ({ ...a, amount: a.amount.toString() })), engine: "permit2" });
  log(`   batch ${rcA.status}, gas ${rcA.gasUsed} vs one-by-one ${oneByOne} (${((Number(oneByOne - rcA.gasUsed) / Number(oneByOne)) * 100).toFixed(1)}% less) · ${vA.summary}`);
  out.A = { plan: pa, simulation: asmA.simulation, hash: rcA.transactionHash, gasUsed: rcA.gasUsed.toString(), oneByOneGasUsed: oneByOne.toString(), verify: vA, actions: batchA.actions.map((a) => ({ ...a, amount: a.amount.toString() })) };

  // ── B ───────────────────────────────────────────────────────────────────────────────────────
  log("B. eip3009 + Multicall3: two transfers break after signing; the rest still go");
  const wb = await freshWallet(10_000n * 10n ** 6n);
  const batchB = validateBatch({ from: wb.account.address, engine: "eip3009", policy: "skip-failed", actions: [
    { to: R(6), amount: "1000", label: "vendor 1" }, { to: R(7), amount: "1500", label: "vendor 2 (authorization cancelled)" }, { to: R(8), amount: "2000", label: "vendor 3" },
    { to: R(9), amount: "2500", label: "vendor 4" }, { to: R("a"), amount: "3000", label: "vendor 5 (balance spent meanwhile)" },
  ] });
  const pb = await plan(batchB, { client });
  const sigsB = await sign(wb, pb);
  // after signing: the wallet cancels authorization #2 and spends 2,500 USDC elsewhere (only 7,500 left)
  const auth2 = pb.sign.typedData[1].message;
  const cancelSig = parseSignature(await wb.account.signTypedData({ domain: USDC_DOMAIN, types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] }, primaryType: "CancelAuthorization", message: { authorizer: wb.account.address, nonce: auth2.nonce } }));
  const cancelAbi = [{ type: "function", name: "cancelAuthorization", stateMutability: "nonpayable", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [] }];
  await pub.waitForTransactionReceipt({ hash: await wb.wallet.writeContract({ address: TOKENS.USDC.address, abi: cancelAbi, functionName: "cancelAuthorization", args: [wb.account.address, auth2.nonce, 27 + cancelSig.yParity, cancelSig.r, cancelSig.s] }) });
  await pub.waitForTransactionReceipt({ hash: await wb.wallet.writeContract({ address: TOKENS.USDC.address, abi: ABI.erc20, functionName: "transfer", args: [R("f"), 2_500n * 10n ** 6n] }) });
  const asmB = await assemble(batchB, { ...pb, nextNonce: await pub.getTransactionCount({ address: wb.account.address }) }, sigsB, { client });
  log(`   simulation before sending: ${asmB.simulation.actions.map((a) => `#${a.index} ${a.success ? "✓" : `✗ ${a.reason}`}`).join(" · ")}`);
  const rcB = await sendPrepared(wb, asmB.tx);
  const vB = await verifyBatch(client, { hash: rcB.transactionHash, from: wb.account.address, actions: batchB.actions.map((a) => ({ ...a, amount: a.amount.toString() })), engine: "eip3009" });
  log(`   batch ${rcB.status} · ${vB.summary}`);
  for (const a of vB.actions) log(`     #${a.index} ${a.executed ? "happened" : `did not happen — ${a.reason}`}`);
  out.B = { plan: pb, simulation: asmB.simulation, hash: rcB.transactionHash, gasUsed: rcB.gasUsed.toString(), verify: vB, actions: batchB.actions.map((a) => ({ ...a, amount: a.amount.toString() })), changes: ["authorization #2 cancelled by the wallet after signing", "2,500 USDC spent elsewhere after signing (7,500 left for 10,000 of transfers)"] };

  // ── C ───────────────────────────────────────────────────────────────────────────────────────
  log("C. permit2 is atomic: one failing transfer reverts all; the agent re-plans and the rest go");
  const wc = await freshWallet(6_000n * 10n ** 6n);
  const batchC = validateBatch({ from: wc.account.address, engine: "permit2", actions: [
    { to: R("b"), amount: "1000", label: "refund 1" }, { to: R("c"), amount: "1500", label: "refund 2" }, { to: R("d"), amount: "2000", label: "refund 3" }, { to: R("e"), amount: "1500", label: "refund 4" },
  ] });
  const pc = await plan(batchC, { client });
  for (const ap of pc.approvals) await sendPrepared(wc, ap);
  const sigC = await sign(wc, pc);
  await pub.waitForTransactionReceipt({ hash: await wc.wallet.writeContract({ address: TOKENS.USDC.address, abi: ABI.erc20, functionName: "transfer", args: [R("f"), 1_000n * 10n ** 6n] }) }); // 5,000 left for 6,000
  const asmC = await assemble(batchC, { ...pc, nextNonce: await pub.getTransactionCount({ address: wc.account.address }) }, sigC, { client });
  log(`   simulation before sending: ${asmC.simulation.ok ? "ok" : `reverts — ${asmC.simulation.reason}`}`);
  // send it anyway (gas fixed, as a careless relayer would) to show the on-chain behaviour
  const hashC = await wc.wallet.sendTransaction({ to: asmC.tx.tx.to, data: asmC.tx.tx.data, gas: 400_000n, maxFeePerGas: BigInt(asmC.tx.tx.maxFeePerGas), maxPriorityFeePerGas: 0n });
  const rcC = await pub.waitForTransactionReceipt({ hash: hashC });
  const vC = await verifyBatch(client, { hash: hashC, from: wc.account.address, actions: batchC.actions.map((a) => ({ ...a, amount: a.amount.toString() })), engine: "permit2" });
  log(`   sent anyway: ${rcC.status} · ${vC.summary}`);
  const replan = await plan(batchC, { client });
  log(`   re-plan: ${replan.summary}`);
  let recovered = null;
  if (replan.batchActions?.length) {
    for (const ap of replan.approvals) await sendPrepared(wc, ap);
    const asm2 = await assemble(batchC, replan, await sign(wc, replan), { client });
    const rc2 = await sendPrepared(wc, asm2.tx);
    const kept = batchC.actions.filter((a) => replan.batchActions.includes(a.index));
    recovered = { hash: rc2.transactionHash, verify: await verifyBatch(client, { hash: rc2.transactionHash, from: wc.account.address, actions: kept.map((a) => ({ ...a, amount: a.amount.toString() })), engine: "permit2" }) };
    log(`   clean batch: ${rc2.status} · ${recovered.verify.summary}`);
  }
  out.C = { plan: pc, simulation: asmC.simulation, reverted: { hash: hashC, status: rcC.status, verify: vC }, replan, recovered, actions: batchC.actions.map((a) => ({ ...a, amount: a.amount.toString() })), change: "1,000 USDC spent elsewhere after signing (5,000 left for 6,000 of transfers)" };

  await writeFile(new URL("../public/runs/fork-proof.json", import.meta.url), JSON.stringify({ recordedAt: new Date().toISOString(), network: "Anvil fork of Pharos Pacific", note: "test wallets: fresh keys funded on the fork only", ...out }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  log("wrote public/runs/fork-proof.json");
} finally {
  fork.stop();
}
process.exit(0);
