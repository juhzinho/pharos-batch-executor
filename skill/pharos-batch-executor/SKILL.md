---
name: pharos-batch-executor
description: Run several independent token transfers on Pharos Pacific Mainnet (USDC, WPROS) as ONE transaction instead of one by one — payroll, vendor payouts, refunds, airdrops to a list. Checks every action against the wallet before anything is signed, builds what the wallet signs (one Permit2 signature, or one gasless EIP-3009 authorization per USDC transfer batched through Multicall3), measures gas on chain both ways, and on failure says which action failed, why, and what happened to the rest. Use for "pay these people", "send to this list", "batch transfers", "multisend", "pay this CSV" on Pharos.
license: MIT
metadata:
  author: juhzinho
  version: "1.0.0"
  chain: "Pharos Pacific Mainnet (1672)"
---

# Pharos Batch Executor

A Skill for agents that would otherwise fire N transfers as N transactions. It takes a list of at least 3
independent transfers and turns it into **one transaction**, with a report the user can trust before signing:

```
list (JSON / CSV) ─▶ pre-flight each action ─▶ policy ─┬─ refused (all-or-nothing, a failing action)
                    (balance left after the ones      └─ batch ─▶ wallet signs EIP-712 ─▶ assemble + simulate per action
                     before it, blacklist, simulated                                     ─▶ wallet sends ─▶ verify receipt
                     transfer)                                                              (which happened, which did not, why)
```

## When to use

- The user has several transfers to make from one wallet and wants fewer confirmations or less gas.
- The user pastes a list or a CSV of recipients and amounts.
- A batch was sent and the user asks what happened to each payment.

## Two engines (both use contracts already on Pacific)

| engine | the wallet signs | the transaction | if one action fails |
|---|---|---|---|
| `permit2` (default) | **one** EIP-712 `PermitBatchTransferFrom` for every transfer (USDC and WPROS) | `Permit2.permitTransferFrom(batch)` | atomic: all revert. The pre-flight removes failing actions **before** signing |
| `eip3009` | one gasless `TransferWithAuthorization` per transfer (USDC only) | `Multicall3.aggregate3` with `allowFailure` | only that transfer fails; the rest go through |

Permit2 needs an ERC-20 allowance once per token: `approve: "standing"` (default — later batches skip it; Permit2
still moves nothing without a new signature naming each recipient and amount) or `"exact"` (sized to this batch,
so every batch needs its own and the report says so). Contracts and how they were confirmed:
[references/contracts.md](references/contracts.md). Batch format: [references/batch-format.md](references/batch-format.md).

## How to run it

The executable lives in the repository root (`tasks/batch/batch.js`). From there:

```bash
npm install
npm run batch -- plan batches/payroll.json                          # pre-flight + policy + what to sign + gas report
npm run batch -- plan pay.csv --from 0x… --engine eip3009 --policy all-or-nothing
npm run batch -- assemble .batch/plan.json --sig 0x…                 # the one unsigned transaction, simulated per action
npm run batch -- verify .batch/plan.json --tx 0x…                    # after sending: each action happened or not, and why
npm run batch -- demo                                                # the full loop on an Anvil fork with test wallets
```

Exit codes: `0` a batch can be built · `3` refused or blocked (nothing to sign), or `assemble` found that no transfer
would happen (then no transaction is handed over) · `2` a mistake in the input · `1` the chain or RPC failed.

## Rules for the agent

1. **Never sign, never send.** Hand the wallet the EIP-712 data from the plan (`eth_signTypedData_v4`) and return the
   batch as an unsigned transaction. Never ask for a private key.
2. Show the ledger before anything else: every action with ✓/✗, and for each ✗ the reason exactly as reported.
   Never summarise a skipped action as "some payments failed".
3. Respect the policy the user chose. `all-or-nothing` refuses the whole batch if one action would fail; do not
   silently switch to `skip-failed`.
4. Report gas honestly, with the numbers from the plan: the batch vs one by one, **the one-time approval and the
   batch from which it pays for itself**, and say plainly when a batch costs more gas (EIP-3009) — the gain there is
   steps and per-action failure isolation.
5. After sending, run `verify` and report per action. A Permit2 batch that reverted moved nothing: say so, re-plan
   (the pre-flight will drop the action that no longer fits) and ask for a new signature.
6. Refuse a wallet with code or an EIP-7702 delegation (the plan blocks it): its signatures go through EIP-1271.
