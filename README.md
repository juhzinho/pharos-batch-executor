# Pharos Batch Executor

A **SkillEngine skill** for Pharos Pacific that takes several independent token transfers — payroll, vendor
payouts, refunds — and turns them into **one transaction** instead of firing them one by one. Before anything is
signed it checks every action against the wallet, measures the gas both ways on chain, and when something fails it
says which action, why, and what happened to the rest.

**Live demo:** https://pharos-batch-executor-juhzinho.vercel.app · **Skill:** [skill/pharos-batch-executor/SKILL.md](skill/pharos-batch-executor/SKILL.md)

```
list (JSON / CSV) ─▶ pre-flight each action ─▶ policy ─┬─ refused  (all-or-nothing and an action would fail)
                    balance left after the ones       └─ batch ─▶ wallet signs EIP-712 ─▶ assemble, simulate per action
                    before it · USDC blacklist ·                 ─▶ wallet sends ─▶ verify the receipt per action
                    the token's own transfer, simulated
```

The agent never holds a key: the wallet signs typed EIP-712 data, the batch comes back as an unsigned transaction.

## Requirements

| # | Requirement | How it is met |
|---|---|---|
| 01 | Accepts a list of at least 3 independent actions | A JSON batch or a CSV (`to,amount[,token][,label]`), 3 to 100 transfers of USDC or WPROS. Amounts are decimal strings parsed exactly (no floats), addresses checksummed, the zero address and the wallet itself refused, identical actions flagged as a possible double payment ([format](skill/pharos-batch-executor/references/batch-format.md)). |
| 02 | Executes them as a batch | **One transaction**, two engines on contracts already on Pacific: **Permit2** — one EIP-712 signature covering every transfer, `permitTransferFrom(batch)`; **EIP-3009 + Multicall3** — one gasless USDC authorization per transfer, all in one `aggregate3`. Sent for real on a fork of Pacific: 5 transfers in 2 tokens in one transaction ([fork-proof.json](public/runs/fork-proof.json)). |
| 03 | Reports the gas saving or step reduction | Measured on chain at the same block: each transfer estimated as its own transaction from the wallet vs the one batch. Payroll on mainnet: **219,348 vs 262,668 gas, 16.5 % less**; 4 transactions → 1. Real receipts on the fork: **203,240 vs 266,008 gas, 23.6 % less**. The one-time Permit2 approval is counted too (the first batch costs 33.4 % more; ahead overall from the 4th batch), and when a batch costs *more* gas (EIP-3009: 22.1 % more) the report says so and names what is gained instead. |
| 04 | Handles partial failure clearly | Before signing, each action is checked with the balance left after the ones before it: the failing one is named with its reason (`insufficient USDC: 137,839.927209 left after the actions before it, 999,999 needed`). `skip-failed` leaves it out and batches the rest; `all-or-nothing` refuses the whole batch. After sending, every action is matched to a `Transfer` event in the receipt: on the fork, two transfers broke **after** signing and the report shows `3 of 5 happened`, each failure with the token's own reason; an atomic Permit2 batch that reverted is reported as *none happened*, then re-planned and sent clean. |

## What it found on Pacific (recorded plans, mainnet)

All read-only. The paying wallet is a real Pacific address holding USDC and WPROS; nothing is signed or sent.

| plan | outcome | gas |
|---|---|---|
| [Payroll, Permit2, skip-failed](public/runs/plan-permit2.json) — 5 transfers, #3 has one zero too many | **partial**: #1, #2, #4, #5 batched; #3 left out (not enough USDC after the ones before it) | batch 219,348 vs 262,668 one by one (−16.5 %); approval 131,144 once |
| [Same, all-or-nothing](public/runs/plan-all-or-nothing.json) | **refused**: action 3 would fail — nothing to sign, nothing moves | — |
| [Vendors CSV, EIP-3009](public/runs/plan-eip3009.json) — 4 USDC payments | **ready** | batch 389,755 vs 319,144 (+22.1 %): each authorization verifies a signature. Permit2 would have used 254,189 (−20.4 %) — the report shows both |

### The bigger the batch, the bigger the saving ([scaling.json](public/runs/scaling.json))

The same kind of USDC payroll planned with 3 to 100 transfers, gas estimated on mainnet:

| transfers | one by one | permit2 batch | eip3009 batch | permit2 gas per transfer |
|---:|---:|---:|---:|---:|
| 3 | 239,358 | 215,222 (−10.1 %) | 306,890 (+28.2 %) | 71,741 |
| 10 | 797,860 | 488,229 (−38.8 %) | 887,191 (+11.2 %) | 48,823 |
| 100 | 7,978,516 | 3,999,654 (−49.9 %) | 8,350,036 (+4.7 %) | 39,997 |

One by one costs ~79,800 gas per transfer at any size; the batch shares the transaction's fixed cost, so Permit2
tends to half. EIP-3009's extra cost per transfer (a signature check) also shrinks as the batch grows. A 100-action
plan takes ~20 s live.

## The full loop on a fork ([fork-proof.json](public/runs/fork-proof.json))

`npm run batch -- demo` starts an Anvil fork of Pacific mainnet, funds **fresh test keys on the fork only**, and has
them sign and send exactly what the agent prepared:

| | scenario | result |
|---|---|---|
| A | Permit2, 4 USDC + 1 WPROS; the same 5 also sent one by one | one transaction, all 5 verified; **203,240 vs 266,008 gas (−23.6 %)** from real receipts |
| B | EIP-3009 + Multicall3, skip-failed; after signing, authorization #2 is cancelled and the balance is spent | **3 of 5 happened**; #2 `FiatTokenV2: authorization is used or canceled`, #5 `ERC20: transfer amount exceeds balance` — the others unaffected |
| C | Permit2 (atomic); the balance drops after signing | the simulation catches it (`TRANSFER_FROM_FAILED`); sent anyway → reverted, **none of the 4 happened**; re-planned → #4 left out, the clean batch of 3 goes through |

## Run it

```bash
npm install
npm run batch -- plan batches/payroll.json                       # ledger + policy + what to sign + gas report
npm run batch -- plan batches/vendors.csv --from 0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d --engine eip3009
npm run batch -- plan batches/payroll.json --policy all-or-nothing   # exit 3: refused
npm run batch -- assemble .batch/plan.json --sig 0x…              # the one unsigned transaction, simulated per action
npm run batch -- verify .batch/plan.json --tx 0x…                 # after sending: per action, happened or not, and why
npm run batch -- demo                                             # the fork proof above (Anvil comes as an npm dependency)
npm run web                                                       # the demo site on http://localhost:3130
```

Exit codes: `0` a batch can be built · `3` refused or blocked, or (assemble) no transfer would happen — then no
transaction is handed over · `2` a mistake in the input · `1` the chain or RPC failed.

The plan file has the EIP-712 data ready for `eth_signTypedData_v4`, the approvals as unsigned transactions with
`cast send` equivalents, and every gas figure. Optional settings: [.env.example](.env.example).

## Design notes

- **Why two engines.** Multicall3 alone cannot move a wallet's tokens (the token would see Multicall3 as the
  sender). Permit2 can, with one signature, and is the cheapest — but atomic. EIP-3009 authorizations can be
  batched with `allowFailure`, so a transfer that breaks at execution does not stop the others — at a higher gas
  cost. The plan always shows the other engine's number.
- **Gas before the wallet has signed.** The batch is estimated with an equivalent test signer (a fresh key) whose
  balances are applied by state override: same calls, same storage writes. Checked against real receipts on the
  fork: the plan estimated 203,585 gas for the batch, the receipt used 203,240; one by one, 267,418 estimated vs
  266,008 used.
- **The approval, honestly.** Permit2 needs an ERC-20 allowance per token. `standing` (default) approves once and
  later batches skip it — Permit2 still moves nothing without a new signature naming each recipient, amount and a
  one-hour deadline; `exact` approves only this batch and the report says every batch then costs the approval too.
- **EIP-7702 is live on Pacific.** A delegated address verifies signatures through EIP-1271, so a plain signature
  would be rejected: the plan blocks such a wallet (and contracts) instead of producing a batch that cannot work.
- **Gas money.** With Permit2 the wallet itself sends the batch; if its PROS does not cover the gas limit × max fee,
  the plan warns. With EIP-3009 any funded account can send it.

## Tests

```bash
npm test                 # 14 unit tests: parsing, validation, both engines' signed data, revert decoding, pre-flight
npm run test:e2e         # 12 live checks on Pacific mainnet: plans, policies, assemble + simulate, a real receipt, CLI, API
node test/e2e.js --fork  # + the full send-and-verify loop on a fork
```

## Files

- `lib/actions.js` — batch validation, exact amounts, CSV · `lib/preflight.js` — wallet state and per-action checks
- `lib/engines.js` — Permit2 and EIP-3009 typed data and calls, revert decoding · `lib/batch.js` — plan and assemble
- `lib/verify.js` — the receipt, per action · `tasks/batch/batch.js` — the CLI · `api/plan.js` — the live planner
- `scripts/fork-proof.js` — the fork loop · `scripts/record.js` — the recorded mainnet plans
- [Contracts and how they were confirmed](skill/pharos-batch-executor/references/contracts.md)

MIT
