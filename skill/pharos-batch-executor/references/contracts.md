# Contracts (Pharos Pacific Mainnet, chain 1672)

| Role | Address | How it was confirmed |
|---|---|---|
| USDC (Circle FiatToken v2.2) | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` | official token registry; `decimals()` = 6; `DOMAIN_SEPARATOR()` = EIP-712 {name "USDC", version "2", chainId 1672}; `transferWithAuthorization`, `authorizationState`, `isBlacklisted` present |
| WPROS (WETH9 layout) | `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` | official token registry; `decimals()` = 18; no EIP-3009 |
| Permit2 (canonical) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | code present; `DOMAIN_SEPARATOR()` = {name "Permit2", chainId 1672, this address} |
| Multicall3 (canonical) | `0xcA11bde05977b3631167028862bE2a173976CA11` | code present; `aggregate3` with per-call `allowFailure` |
| PROS/USD (Chainlink self-managed) | `0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466` | docs.pharos.xyz → Oracles; 18 decimals — used only to show the fee in USD |

## Storage slots (simulations only)

Used for `eth_call` / `eth_estimateGas` **state overrides** — nothing is ever written on chain:

| token | balance mapping | allowance mapping | check |
|---|---|---|---|
| USDC | slot 9 | slot 10 | overriding the slot changes `balanceOf` / `allowance` of a real holder to the written value |
| WPROS | slot 3 | slot 4 | same check |

## Network facts that shape the design

- **EIP-7702 is live on Pacific.** An address with code `0xef0100…` is delegated: USDC and Permit2 then verify
  signatures through EIP-1271 on the delegate, so a plain ECDSA signature from the key is rejected. The plan blocks
  such wallets instead of producing a batch that cannot work.
- The base fee read in every recorded plan is 10 gwei (it is read from the block each time, never assumed); the plan sets `maxFeePerGas` = 2 × base fee and a 20 % gas-limit margin.
- The public RPC serves `eth_getLogs` over at most 1,000 blocks.
