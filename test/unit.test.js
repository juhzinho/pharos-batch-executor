import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseAmount, parseCsv, validateBatch } from "../lib/actions.js";
import { decodeAggregate3, decodeRevert, eip3009Call, eip3009TypedData, permit2Call, permit2TypedData } from "../lib/engines.js";
import { fmt, preflight } from "../lib/preflight.js";
import { ABI, MULTICALL3, PERMIT2, TOKENS } from "../lib/contracts.js";

const W = "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d";
const R = (n) => `0x${String(n).repeat(40)}`;
const three = [{ to: R(1), amount: "1" }, { to: R(2), amount: "2.5" }, { to: R(3), amount: "3" }];

// ───────── the list of actions ─────────
test("a batch needs a wallet and at least 3 independent actions; amounts are exact", () => {
  const b = validateBatch({ from: W, actions: three });
  assert.equal(b.from, getAddress(W));
  assert.deepEqual(b.actions.map((a) => a.amount), [1_000_000n, 2_500_000n, 3_000_000n]);
  assert.equal(b.engine, "permit2");
  assert.equal(b.policy, "skip-failed");
  assert.throws(() => validateBatch({ from: W, actions: three.slice(0, 2) }), /at least 3/);
  assert.throws(() => validateBatch({ actions: three }), /from/);
});

test("amounts: decimal strings only, within the token's decimals, positive", () => {
  assert.equal(parseAmount("850.5", 6), 850_500_000n);
  assert.equal(parseAmount("12.5", 18), 12_500_000_000_000_000_000n);
  assert.throws(() => parseAmount("1.0000001", 6), /more than 6 decimals/);
  assert.throws(() => parseAmount("-5", 6), /not an amount/);
  assert.throws(() => parseAmount("0", 6), /positive/);
  assert.throws(() => parseAmount("1e6", 6), /not an amount/);
});

test("actions are checked one by one, with where the problem is", () => {
  const bad = (a) => () => validateBatch({ from: W, actions: [...three.slice(0, 2), a] });
  assert.throws(bad({ to: "0x123", amount: "1" }), /actions\[2\].to/);
  assert.throws(bad({ to: "0x0000000000000000000000000000000000000000", amount: "1" }), /zero address/);
  assert.throws(bad({ to: W, amount: "1" }), /paying wallet itself/);
  assert.throws(bad({ to: R(4), amount: "1", token: "DOGE" }), /not supported/);
  assert.throws(() => validateBatch({ from: W, engine: "eip3009", actions: [...three.slice(0, 2), { to: R(4), amount: "1", token: "WPROS" }] }), /no EIP-3009/);
  assert.throws(() => validateBatch({ from: W, engine: "magic", actions: three }), /engine/);
});

test("an identical action (same recipient, token, amount) is flagged as a possible double payment", () => {
  const b = validateBatch({ from: W, actions: [...three, { to: R(1), amount: "1" }] });
  assert.match(b.warnings[0], /actions 1 and 4 are identical/);
});

test("permit2 approval: standing by default, exact on request, anything else refused", () => {
  assert.equal(validateBatch({ from: W, actions: three }).approve, "standing");
  assert.equal(validateBatch({ from: W, approve: "exact", actions: three }).approve, "exact");
  assert.throws(() => validateBatch({ from: W, approve: "infinite", actions: three }), /approve must be one of/);
});

test("amounts in reports are exact (no floating point)", () => {
  assert.equal(fmt(137_839_927_209n, 6), "137,839.927209");
  assert.equal(fmt(283_979_622_030_202_833_595n, 18), "283.979622");
  assert.equal(fmt(9_007_199_254_740_993_000_001n, 6), "9,007,199,254,740,993.000001", "beyond 2^53");
  assert.equal(fmt(1n, 18), "<0.000001");
  assert.equal(fmt(0n, 6), "0");
});

test("CSV with a header", () => {
  const rows = parseCsv("to,amount,label\n# a comment\n0x1111111111111111111111111111111111111111,10,a\n0x2222222222222222222222222222222222222222,20,b\n");
  assert.deepEqual(rows.map((r) => r.amount), ["10", "20"]);
  assert.throws(() => parseCsv("address,value\n0x1,1"), /must contain “to”/);
});

// ───────── engines ─────────
test("permit2: one typed message covering every transfer; the call carries each recipient and amount", async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const b = validateBatch({ from: acct.address, actions: [...three, { to: R(4), amount: "1.5", token: "WPROS" }] });
  const t = permit2TypedData(b.from, b.actions, { deadline: 2_000_000_000 });
  assert.equal(t.message.spender, b.from);
  assert.deepEqual(t.message.permitted.map((p) => p.token), [TOKENS.USDC.address, TOKENS.USDC.address, TOKENS.USDC.address, TOKENS.WPROS.address]);
  const sig = await acct.signTypedData(t);
  const call = permit2Call(b.from, b.actions, t, sig);
  assert.equal(call.to, PERMIT2);
  const d = decodeFunctionData({ abi: ABI.permit2, data: call.data });
  assert.deepEqual(d.args[1].map((x) => [x.to, x.requestedAmount]), b.actions.map((a) => [a.to, a.amount]));
  assert.equal(d.args[2], b.from);
});

test("eip3009: one authorization per transfer, each with its own random nonce, all inside one aggregate3", async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const b = validateBatch({ from: acct.address, engine: "eip3009", actions: three });
  const ts = eip3009TypedData(b.from, b.actions, { validBefore: 2_000_000_000 });
  assert.equal(new Set(ts.map((t) => t.message.nonce)).size, 3, "unique nonces");
  const sigs = await Promise.all(ts.map((t) => acct.signTypedData(t)));
  const call = eip3009Call(ts, sigs, { allowFailure: true });
  assert.equal(call.to, MULTICALL3);
  const d = decodeFunctionData({ abi: ABI.multicall3, data: call.data });
  assert.equal(d.args[0].length, 3);
  assert.ok(d.args[0].every((c) => c.allowFailure && c.target === TOKENS.USDC.address));
  const atomic = decodeFunctionData({ abi: ABI.multicall3, data: eip3009Call(ts, sigs, { allowFailure: false }).data });
  assert.ok(atomic.args[0].every((c) => !c.allowFailure), "all-or-nothing → allowFailure false");
});

test("revert reasons are decoded per action (USDC strings, Permit2 errors)", () => {
  const E = parseAbi(["error Error(string)", "error InvalidNonce()", "error SignatureExpired(uint256)"]);
  assert.equal(decodeRevert(encodeErrorResult({ abi: E, errorName: "Error", args: ["FiatTokenV2: authorization is used or canceled"] })), "FiatTokenV2: authorization is used or canceled");
  assert.equal(decodeRevert(encodeErrorResult({ abi: E, errorName: "InvalidNonce" })), "InvalidNonce()");
  assert.equal(decodeRevert(encodeErrorResult({ abi: E, errorName: "SignatureExpired", args: [5n] })), "SignatureExpired(5)");
  const data = encodeFunctionResult({ abi: ABI.multicall3, functionName: "aggregate3", result: [{ success: true, returnData: "0x" }, { success: false, returnData: encodeErrorResult({ abi: E, errorName: "Error", args: ["ERC20: transfer amount exceeds balance"] }) }] });
  assert.deepEqual(decodeAggregate3(data), [{ success: true, reason: null }, { success: false, reason: "ERC20: transfer amount exceeds balance" }]);
});

// ───────── pre-flight ─────────
test("pre-flight: each action sees the balance left after the ones before it; blacklisted recipients are caught", async () => {
  const b = validateBatch({ from: W, actions: [{ to: R(1), amount: "60" }, { to: R(2), amount: "50" }, { to: R(3), amount: "30" }, { to: R(4), amount: "10" }] });
  const fake = { readContract: async ({ functionName, args }) => functionName === "isBlacklisted" && args[0] === getAddress(R(3)), call: async () => ({ data: "0x" }) };
  const wallet = { balance: { [TOKENS.USDC.address]: 100_000_000n }, blacklisted: false, hasCode: false };
  const r = await preflight(fake, 1n, b, wallet);
  assert.deepEqual(r.actions.map((a) => a.ok), [true, false, false, true]);
  assert.match(r.actions[1].reason, /insufficient USDC: 40 left/);
  assert.match(r.actions[2].reason, /blacklisted/);
  assert.equal(r.remaining[TOKENS.USDC.address], 30_000_000n, "100 − 60 − 10");
});

test("pre-flight: when the token refuses an action, its amount stays in the wallet and a later action fits again", async () => {
  // 100 USDC: #1 60 (the token refuses it: paused for that recipient), #2 50, #3 30
  const b = validateBatch({ from: W, actions: [{ to: R(1), amount: "60" }, { to: R(2), amount: "50" }, { to: R(3), amount: "30" }] });
  const calls = [];
  const fake = {
    readContract: async () => false,
    call: async ({ data }) => {
      const d = decodeFunctionData({ abi: ABI.erc20, data });
      calls.push(d.args[0]);
      if (d.args[0] === getAddress(R(1))) throw Object.assign(new Error("execution reverted: Pausable: paused"), { details: "execution reverted: Pausable: paused" });
      return { data: "0x" };
    },
  };
  const r = await preflight(fake, 1n, b, { balance: { [TOKENS.USDC.address]: 100_000_000n }, blacklisted: false, hasCode: false });
  assert.deepEqual(r.actions.map((a) => a.ok), [false, true, true]);
  assert.match(r.actions[0].reason, /USDC refuses the transfer: Pausable: paused/);
  assert.equal(r.remaining[TOKENS.USDC.address], 20_000_000n);
  assert.equal(calls.length, 3, "#2 is simulated once it fits; nothing twice");
});

test("pre-flight: an RPC failure is an error, never reported as the token refusing an action", async () => {
  const b = validateBatch({ from: W, actions: three });
  const fake = { readContract: async () => false, call: async () => { throw new Error("fetch failed: socket hang up"); } };
  await assert.rejects(preflight(fake, 1n, b, { balance: { [TOKENS.USDC.address]: 10n ** 12n }, blacklisted: false, hasCode: false }), /fetch failed/);
});

test("pre-flight: a wallet with an EIP-7702 delegation is a blocker (signatures go through EIP-1271)", async () => {
  const b = validateBatch({ from: W, actions: three });
  const fake = { readContract: async () => false, call: async () => ({ data: "0x" }) };
  const r = await preflight(fake, 1n, b, { balance: { [TOKENS.USDC.address]: 10n ** 12n }, blacklisted: false, hasCode: true, eip7702: true });
  assert.match(r.blockers[0], /EIP-7702/);
});
