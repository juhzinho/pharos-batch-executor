import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbi, parseSignature, toHex } from "viem";
import { ABI, MULTICALL3, PERMIT2, PERMIT2_DOMAIN, TYPES, USDC_DOMAIN } from "./contracts.js";

// Two ways to run N independent transfers as ONE transaction on Pacific:
//
// permit2  — one EIP-712 signature (PermitBatchTransferFrom) covering every transfer, executed by Permit2's
//            permitTransferFrom in one call. Cheapest. Atomic: if any transfer reverts, none happen — so the
//            pre-flight drops (skip-failed) or refuses (all-or-nothing) failing actions before signing.
// eip3009  — one USDC TransferWithAuthorization signature per transfer, all submitted through Multicall3's
//            aggregate3. With skip-failed each call has allowFailure = true: a transfer that fails AT EXECUTION
//            (balance spent meanwhile, authorization expired) does not stop the others. No approval needed.

const randomBytes32 = () => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
};

/** Permit2 batch: the typed data to sign (spender = the wallet itself, which sends the transaction). */
export function permit2TypedData(from, actions, { deadline, nonce }) {
  const n = nonce ?? BigInt(randomBytes32()) >> 8n; // an unordered nonce (bitmap word + bit); random → never collides
  const permitted = actions.map((a) => ({ token: a.tokenAddress, amount: a.amount }));
  return { domain: PERMIT2_DOMAIN, types: TYPES.permit2Batch, primaryType: "PermitBatchTransferFrom", message: { permitted, spender: from, nonce: n, deadline: BigInt(deadline) } };
}

export function permit2Call(from, actions, typed, signature) {
  const details = actions.map((a) => ({ to: a.to, requestedAmount: a.amount }));
  return { to: PERMIT2, data: encodeFunctionData({ abi: ABI.permit2, functionName: "permitTransferFrom", args: [{ permitted: typed.message.permitted, nonce: typed.message.nonce, deadline: typed.message.deadline }, details, from, signature] }) };
}

/** EIP-3009: one typed data per transfer (USDC only). */
export function eip3009TypedData(from, actions, { validBefore }) {
  return actions.map((a) => ({ domain: USDC_DOMAIN, types: TYPES.eip3009, primaryType: "TransferWithAuthorization", message: { from, to: a.to, value: a.amount, validAfter: 0n, validBefore: BigInt(validBefore), nonce: randomBytes32() } }));
}

export function eip3009Call(typeds, signatures, { allowFailure }) {
  const calls = typeds.map((t, i) => {
    const { r, s, yParity, v } = parseSignature(signatures[i]);
    const m = t.message;
    return { target: t.domain.verifyingContract, allowFailure, callData: encodeFunctionData({ abi: ABI.usdc, functionName: "transferWithAuthorization", args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, Number(v ?? 27n + BigInt(yParity)), r, s] }) };
  });
  return { to: MULTICALL3, data: encodeFunctionData({ abi: ABI.multicall3, functionName: "aggregate3", args: [calls] }) };
}

const REVERTS = parseAbi(["error Error(string)", "error Panic(uint256)", "error InvalidSigner()", "error InvalidNonce()", "error SignatureExpired(uint256 signatureDeadline)", "error InvalidAmount(uint256 maxAmount)", "error LengthMismatch()", "error InvalidSignature()", "error InvalidSignatureLength()"]);

/** A readable reason from revert data (USDC require strings, Permit2 custom errors). */
export function decodeRevert(data) {
  if (!data || data === "0x") return "reverted without a reason";
  try {
    const d = decodeErrorResult({ abi: REVERTS, data });
    if (d.errorName === "Error") return String(d.args[0]);
    if (d.errorName === "Panic") return `panic 0x${Number(d.args[0]).toString(16)}`;
    return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
  } catch {
    return `reverted (${data.slice(0, 10)})`;
  }
}

/** Decodes Multicall3 aggregate3 return data into per-call { success, reason }. */
export function decodeAggregate3(returnData) {
  const results = decodeFunctionResult({ abi: ABI.multicall3, functionName: "aggregate3", data: returnData });
  return results.map((r) => ({ success: r.success, reason: r.success ? null : decodeRevert(r.returnData) }));
}
