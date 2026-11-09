import { encodeFunctionData, getAbiItem, toFunctionSignature, toHex, maxUint256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { makeClient } from "./chain.js";
import { ABI, CHAIN_ID, PACIFIC_RPC, PERMIT2, PROS_USD, TOKENS } from "./contracts.js";
import { balanceOverride, errText, fmt, preflight, walletState } from "./preflight.js";
import { decodeAggregate3, decodeRevert, eip3009Call, eip3009TypedData, permit2Call, permit2TypedData } from "./engines.js";

// plan     → pre-flight every action, apply the failure policy, build what the wallet must sign, measure gas
//            (one by one vs the batch) — nothing signed, nothing sent.
// assemble → with the wallet's signature(s): the single batch transaction, simulated per action.

const VALIDITY_SECONDS = 3600;

function unsignedTx(from, to, data, gas, fees, nonce, label, extra = {}) {
  return { label, tx: { chainId: CHAIN_ID, from, to, data, value: "0x0", gas: toHex((gas * 12n) / 10n), maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: "0x0", nonce: toHex(nonce), type: "0x2" }, ...extra };
}

const totalsByToken = (actions) => actions.reduce((m, a) => ({ ...m, [a.tokenAddress]: (m[a.tokenAddress] ?? 0n) + a.amount }), {});

/**
 * Gas of the batch, measured before the real wallet has signed: an equivalent test signer (fresh key, never funded)
 * with the wallet's balances applied as a state override signs the same transfers. Same calls, same storage writes.
 */
async function twinBatchGas(client, blockNumber, batch, actions, wallet, deadline) {
  const twin = privateKeyToAccount(generatePrivateKey());
  const balances = Object.fromEntries(Object.entries(wallet.balance).map(([t, v]) => [t, v > 0n ? v : totalsByToken(actions)[t] ?? 1n]));
  const allowances = batch.engine === "permit2" ? Object.fromEntries(Object.keys(balances).map((t) => [t, maxUint256])) : {};
  const stateOverride = balanceOverride(twin.address, balances, allowances);
  let call;
  if (batch.engine === "permit2") {
    const typed = permit2TypedData(twin.address, actions, { deadline });
    call = permit2Call(twin.address, actions, typed, await twin.signTypedData(typed));
  } else {
    const typeds = eip3009TypedData(twin.address, actions, { validBefore: deadline });
    call = eip3009Call(typeds, await Promise.all(typeds.map((t) => twin.signTypedData(t))), { allowFailure: batch.policy === "skip-failed" });
  }
  return client.estimateGas({ account: twin.address, to: call.to, data: call.data, blockNumber, stateOverride });
}

export async function plan(batch, { client = makeClient(), validitySeconds = VALIDITY_SECONDS } = {}) {
  const head = await client.getBlock();
  const blockNumber = head.number;
  const wallet = await walletState(client, blockNumber, batch);
  const pre = await preflight(client, blockNumber, batch, wallet);
  const failed = pre.actions.filter((a) => !a.ok);
  const passing = pre.actions.filter((a) => a.ok);
  const base = { block: { number: Number(blockNumber), timestamp: Number(head.timestamp) }, from: batch.from, engine: batch.engine, policy: batch.policy, wallet: { pros: wallet.pros.toString(), eip7702: wallet.eip7702, hasCode: wallet.hasCode, balance: mapStr(wallet.balance), permit2Allowance: mapStr(wallet.permit2Allowance) }, actions: pre.actions.map(pubAction), warnings: batch.warnings, blockers: pre.blockers };

  if (pre.blockers.length) return { ...base, outcome: "blocked", summary: `Blocked: ${pre.blockers[0]}.` };
  if (failed.length && batch.policy === "all-or-nothing") return { ...base, outcome: "refused", summary: `All-or-nothing: action${failed.length > 1 ? "s" : ""} ${failed.map((a) => a.index).join(", ")} would fail, so no batch is built (nothing to sign, nothing moves).` };
  if (!passing.length) return { ...base, outcome: "refused", summary: "No action can go through." };

  const deadline = Number(head.timestamp) + validitySeconds;
  const fees = { maxFeePerGas: (head.baseFeePerGas ?? 0n) * 2n };
  const nonce = await client.getTransactionCount({ address: batch.from, blockNumber });

  // what the wallet signs
  const sign = batch.engine === "permit2" ? { kind: "permit2", typedData: permit2TypedData(batch.from, passing, { deadline }) } : { kind: "eip3009", typedData: eip3009TypedData(batch.from, passing, { validBefore: deadline }) };

  // Permit2 needs an ERC-20 allowance per token. "standing" (default, how Permit2 is meant to be used): approved once,
  // every later batch skips it — Permit2 still moves nothing without a new signature naming each recipient and amount.
  // "exact": approve only what this batch moves; the allowance is used up, so the next batch needs another approval.
  const approvals = [];
  const standing = (batch.approve ?? "standing") === "standing";
  let n = nonce;
  if (batch.engine === "permit2") {
    for (const [token, total] of Object.entries(totalsByToken(passing))) {
      if (wallet.permit2Allowance[token] >= total) continue;
      const amount = standing ? maxUint256 : total;
      const data = encodeFunctionData({ abi: ABI.erc20, functionName: "approve", args: [PERMIT2, amount] });
      const gas = await client.estimateGas({ account: batch.from, to: token, data, blockNumber }).catch(() => 60_000n);
      const sym = Object.values(TOKENS).find((t) => t.address === token).symbol;
      approvals.push(unsignedTx(batch.from, token, data, gas, fees, n++, standing ? `Approve ${sym} for Permit2 (standing allowance, once)` : `Approve ${fmt(total, TOKENS[sym].decimals)} ${sym} for Permit2 (this batch only)`, { gas: gas.toString(), cast: castSend(token, ABI.erc20, "approve", [PERMIT2, amount]) }));
    }
  }

  // gas: one by one (each a plain token transfer from the wallet) vs the batch
  const fullBalances = balanceOverride(batch.from, Object.fromEntries(Object.entries(wallet.balance).map(([t, v]) => [t, v > totalsByToken(passing)[t] ? v : totalsByToken(passing)[t] ?? v])));
  const each = await Promise.all(passing.map((a) => client.estimateGas({ account: batch.from, to: a.tokenAddress, data: encodeFunctionData({ abi: ABI.erc20, functionName: "transfer", args: [a.to, a.amount] }), blockNumber, stateOverride: fullBalances })));
  const batchGas = await twinBatchGas(client, blockNumber, batch, passing, wallet, deadline);
  // the other engine, for an honest comparison (EIP-3009 exists for USDC only)
  const otherEngine = batch.engine === "permit2" ? "eip3009" : "permit2";
  const otherGas = otherEngine === "eip3009" && passing.some((a) => a.token !== "USDC") ? null : await twinBatchGas(client, blockNumber, { ...batch, engine: otherEngine }, passing, wallet, deadline).catch(() => null);
  const individual = each.reduce((t, g) => t + g, 0n);
  const approveGas = approvals.reduce((t, a) => t + BigInt(a.gas), 0n);
  const [, prosUsd] = await client.readContract({ address: PROS_USD, abi: ABI.feed, functionName: "latestRoundData", blockNumber });
  const cost = (g) => ({ gas: g.toString(), pros: Number(g * (head.baseFeePerGas ?? 0n)) / 1e18, usd: (Number(g * (head.baseFeePerGas ?? 0n)) / 1e18) * (Number(prosUsd) / 1e18) });
  const gas = {
    baseFeeGwei: Number(head.baseFeePerGas ?? 0n) / 1e9,
    prosUsd: Number(prosUsd) / 1e18,
    individual: { ...cost(individual), perAction: each.map(String), transactions: passing.length },
    batch: { ...cost(batchGas), transactions: 1, measuredWith: "an equivalent test signer (the wallet has not signed yet): same calls and storage writes, balances applied by state override" },
    approval: approvals.length ? { ...cost(approveGas), mode: standing ? "standing" : "exact", note: standing ? "once per token: a standing ERC-20 allowance to Permit2; later batches skip it" : "exact: sized to this batch and used up by it, so every batch needs its own approval", firstBatchTotal: (batchGas + approveGas).toString(), firstBatchVsIndividualPct: (Number(individual - (batchGas + approveGas)) / Number(individual)) * 100,
      // standing: k batches cost k·batch + approval vs k·individual → ahead from batch floor(approval / saving) + 1
      breakEvenBatch: standing && individual > batchGas ? Number(approveGas / (individual - batchGas)) + 1 : null } : null,
    // positive = the batch uses less gas than one-by-one; negative = it costs more (said plainly in the report)
    saving: { gas: (individual - batchGas).toString(), pct: (Number(individual - batchGas) / Number(individual)) * 100 },
    other: otherGas == null ? null : { engine: otherEngine, ...cost(otherGas), vsIndividualPct: (Number(individual - otherGas) / Number(individual)) * 100 },
    steps: { individual: `${passing.length} transactions, ${passing.length} wallet confirmations`, batch: `${sign.kind === "permit2" ? "1 signature" : `${passing.length} gasless signatures`} + 1 transaction${approvals.length ? ` (+ ${approvals.length} ${standing ? "one-time " : ""}approval${approvals.length > 1 ? "s" : ""})` : ""}` },
  };

  // the sender pays gas: with permit2 that is the wallet itself (it is the spender); a node accepts a transaction only
  // if the balance covers gasLimit × maxFeePerGas
  const limits = (batchGas * 12n) / 10n + approvals.reduce((t, a) => t + BigInt(a.tx.gas), 0n);
  const need = limits * fees.maxFeePerGas;
  const funds = wallet.pros >= need ? [] : [`the wallet holds ${fmt(wallet.pros, 18)} PROS; sending ${approvals.length ? "the approvals and " : ""}the batch needs up to ${fmt(need, 18)} PROS for gas${batch.engine === "eip3009" ? " — with EIP-3009 any funded account can send the batch: the signatures alone authorize the transfers" : ""}`];

  return {
    ...base,
    warnings: [...base.warnings, ...funds],
    outcome: failed.length ? "partial" : "ready",
    summary: failed.length ? `${passing.length} of ${pre.actions.length} actions go into the batch; skipped: ${failed.map((a) => `#${a.index} (${a.reason})`).join("; ")}.` : `All ${passing.length} actions fit in one transaction.`,
    batchActions: passing.map((a) => a.index),
    deadline,
    sign: jsonSafe(sign),
    approvals,
    nextNonce: n,
    gas,
  };
}

/**
 * The batch transaction from the wallet's signature(s), simulated at the head block with the real wallet state
 * (a pending approval is applied as a state override and reported). Per-action results for eip3009.
 */
export async function assemble(batch, planned, signatures, { client = makeClient(), extraOverride } = {}) {
  const sigs = Array.isArray(signatures) ? signatures : [signatures];
  const actions = planned.batchActions.map((i) => batch.actions.find((a) => a.index === i));
  const head = await client.getBlock();
  const typed = reviveTyped(planned.sign.typedData);
  let call;
  if (planned.sign.kind === "permit2") {
    if (sigs.length !== 1) throw new Error("permit2 needs exactly one signature");
    call = permit2Call(batch.from, actions, typed, sigs[0]);
  } else {
    if (sigs.length !== actions.length) throw new Error(`eip3009 needs ${actions.length} signatures, one per action (got ${sigs.length})`);
    call = eip3009Call(typed, sigs, { allowFailure: batch.policy === "skip-failed" });
  }
  const pending = Object.fromEntries((planned.approvals ?? []).map((a) => [a.tx.to, maxUint256]));
  // extraOverride (tests/demos with a test signer only): balances applied for the simulation, and reported
  const stateOverride = Object.keys(pending).length || extraOverride ? balanceOverride(batch.from, extraOverride ?? {}, pending) : undefined;
  let simulation;
  try {
    const res = await client.call({ account: batch.from, to: call.to, data: call.data, blockNumber: head.number, stateOverride });
    const per = planned.sign.kind === "eip3009" ? decodeAggregate3(res.data) : actions.map(() => ({ success: true, reason: null }));
    simulation = { ok: per.every((p) => p.success), actions: actions.map((a, i) => ({ index: a.index, ...per[i] })), overrides: [...(Object.keys(pending).length ? ["the pending Permit2 approval"] : []), ...(extraOverride ? ["test balances"] : [])] };
  } catch (e) {
    const data = e?.walk?.((x) => typeof x?.data === "string" && x.data.startsWith("0x"))?.data;
    simulation = { ok: false, reason: data ? decodeRevert(data) : errText(e), actions: actions.map((a) => ({ index: a.index, success: false, reason: "the whole batch reverts" })) };
  }
  const gas = simulation.ok || planned.sign.kind === "eip3009" ? await client.estimateGas({ account: batch.from, to: call.to, data: call.data, blockNumber: head.number, stateOverride }).catch(() => BigInt(planned.gas.batch.gas)) : BigInt(planned.gas.batch.gas);
  const fees = { maxFeePerGas: (head.baseFeePerGas ?? 0n) * 2n };
  const tx = unsignedTx(batch.from, call.to, call.data, gas, fees, planned.nextNonce, `Batch: ${actions.length} transfers in one transaction (${planned.sign.kind})`);
  return { block: { number: Number(head.number) }, tx, simulation };
}

function castSend(to, abi, fn, args) {
  const item = getAbiItem({ abi, name: fn, args });
  return `cast send ${to} "${toFunctionSignature(item)}" ${args.map(String).join(" ")} --rpc-url ${PACIFIC_RPC}`;
}
const mapStr = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()]));
const pubAction = (a) => ({ index: a.index, to: a.to, token: a.token, amount: a.amount.toString(), decimals: a.decimals, label: a.label, ok: a.ok, reason: a.reason });
/** Typed data with bigints as strings (JSON, wallets) — and back. */
export const jsonSafe = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
function reviveTyped(t) {
  const big = (v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v);
  const revive = (one) => ({ ...one, message: Object.fromEntries(Object.entries(one.message).map(([k, v]) => [k, Array.isArray(v) ? v.map((p) => ({ ...p, amount: BigInt(p.amount) })) : k === "nonce" && one.primaryType === "TransferWithAuthorization" ? v : big(v)])) });
  return Array.isArray(t) ? t.map(revive) : revive(t);
}
