# LedgerPump

[![Built on QoreChain](https://build.qorechain.io/badge/ledgerpump.svg)](https://build.qorechain.io/p/ledgerpump) [![CI](https://github.com/lahdlahd/ledgerpump/actions/workflows/ci.yml/badge.svg)](https://github.com/lahdlahd/ledgerpump/actions/workflows/ci.yml)

**Trust every transaction. Reconcile every litre.**

▶️ **Demo video (2:54):** https://youtu.be/dJErpyILw6c

**Live dashboard:** https://lahdlahd.github.io/ledgerpump/ (public watchtower view, refreshed from QoreChain testnet) · **Fest project page:** https://build.qorechain.io/p/ledgerpump

Fuel station owners in Nigeria often run stations in several cities and rely on daily reports from managers. Money leaks in the gaps: fuel leaves the tank without passing a pump, cash doesn't match the litres sold, and a delivery drops less than its waybill. By the time the owner notices, the records have been "adjusted".

**LedgerPump makes the books tamper-evident and makes the chain pay only for honest days, without ever seeing the books.** It's a post-quantum reconciliation and settlement system on [QoreChain](https://qorechain.io), built for the [Build Before Q-Day](https://build.qorechain.io) Developer Fest (Protocol Builders track). Everything below runs on QoreChain testnet with **synthetic** data, and every claim links to a transaction.

## How it works (one chain of evidence)

```
 Station device                     QoreChain: LedgerPump rollup (RDK)          QoreChain EVM
 ──────────────                     ──────────────────────────────────          ─────────────
 1. Reconcile the day:              3. Signed leaf posted to the inbox:          5. PayoutGateV3 pays the
    meters vs tanks,                   station · date · SHA-256(ciphertext)         station only if:
    litres vs money,                   · status · ZK commitment                     • it can rebuild that signed
    received vs waybill                signed with ML-DSA-87                          leaf byte for byte,
 2. Encrypt the report              4. Batched with canonical state roots;          • QoreChain's pqcVerify
    (ML-KEM-1024 + AES-256-GCM)        a 1-hour challenge window; forged             precompile accepts the
    to the owner and the auditor       batches are slashed                           station's ML-DSA-87 signature,
                                                                                    • the Groth16 proof over the same
 Auditor: decrypts, re-runs the     Watchtower: checks every signature,              commitment says the day
 reconciliation, recomputes the     fingerprint and batch without seeing             reconciled
 commitment from the figures        a single figure
```

A proof over different figures, a forged signature, a leaf edited after signing, or a day that didn't reconcile: the chain refuses all of them.

## Proof on testnet

| What happened | Tx |
|---|---|
| ✅ **Paid:** Hilltop, Nov 3. The proof matches the commitment in the station's signed rollup leaf (inbox #28) | `0x5cbc9efcdce47d25b77a702c6226e2e1cc105658db6b81cd9ec814928662b696` |
| ❌ **Refused:** a valid proof over *different* figures than the signed leaf (`LeafSignatureInvalid`) | `0x9c6f03c2a355120cefbe89e3e09028dbdfb069aa5e0b78707c3226941219b60c` |
| ❌ **Refused:** the 600 L theft day. The proof is valid but says "not reconciled" (`NotReconciled`) | `0xac57ca44abccc1ad8d63cd8616398fccdf85eb6a9cc55ee0c61db2969985fb8a` |
| ❌ **Refused:** one byte of the station's ML-DSA-87 signature forged (`BadStationSignature`) | `0xdd2b65fa1c5feec0ec63684a947ea65c9217be4229b8b6cf2761c61bc437e099` |
| ⚔️ **Slashed:** we forged a state root against our own rollup. An independent challenger (Wicketgate's watcher W1) proved it wrong within 12 s, and 1,000 QOR was slashed | `C93AB320110D41FFB5FC448195B05A5CD4803223FD0CB3C8224E4B7B3BFFA660` |
| ✅ **Withdrawn:** 3 QOR to the main chain with a Merkle proof, paid only for reconciled days | `CA9CE5776BAF105EFBBD4D6C0B6588BFEC4623A3A9ABB13780CB84842FB05195` |

The full log of every transaction, with blocks and context, is in [docs/TESTNET_LOG.md](docs/TESTNET_LOG.md). Limits and threats are in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

**Honest limits:**
- The Groth16 trusted setup is single-party (demo only).
- The EVM contract can't read rollup state, so the watchtower checks that a paid leaf is in a finalised batch.
- All stations and figures are synthetic.

**How we got here:** `PayoutGate` (v1) gated payouts on the ZK proof. `PayoutGateV2` added the station's post-quantum signature. `PayoutGateV3` binds both to the signed rollup leaf, and it's the one to judge. V1 and V2 stay deployed, and their txs remain in the log.

## Components

| Component | Path | Status |
|---|---|---|
| Three-way reconciliation engine (meters vs tanks, litres vs money, received vs waybill) | `src/reconcile.ts` | ✅ tested |
| Metadata monitor (missing days, duplicate submissions), with no decryption needed | `src/monitor.ts` | ✅ tested |
| Seeded synthetic data generator | `data/generate.ts` | ✅ tested |
| Post-quantum crypto: ML-DSA-87 station signatures; ML-KEM-1024 + AES-256-GCM report envelopes to readers' keys in QoreChain's KEM registry; inbox post format | `src/crypto.ts`, `rollup/src/post-report.ts` | ✅ tested + on testnet (every report post in the testnet log) |
| Rollup operator scaffold (QoreChain RDK, custom profile, optimistic + qledger-v1) | `rollup/` | ✅ rollup `ledgerpump` created on testnet (see [docs/TESTNET_LOG.md](docs/TESTNET_LOG.md)) |
| Watchtower tier 1 (public, no keys): anchors, ML-DSA-87 signatures, ciphertext commitments, duplicates, canonical batch re-execution, `--challenge` fraud proofs | `src/watchtower.ts`, `rollup/src/watchtower.ts` | ✅ tested + run on testnet (caught a real overwritten ciphertext) |
| Payouts: deposit → treasury pays reconciled station-days (qledger ML-DSA-44 transfers) → station withdrawal → execute with Merkle proof after finalisation | `rollup/src/{deposit,pay,withdraw,claim}.ts` | ✅ full loop on testnet (claim tx in the testnet log) |
| Settlement receipts: ML-DSA-87-signed batch anchors, verified against live chain state | `rollup/src/receipt.ts`, `rollup/receipts/` | ✅ verified on testnet |
| ZK reconciliation proof (Groth16, ~10.5k constraints) + `PayoutGate` on QoreChain EVM: the chain verifies a station reconciled without seeing its books, and pays only reconciled days | `zk/`, `evm/` | ✅ on testnet: reconciled day PAID, theft day REFUSED on-chain (`NotReconciled`) |
| Post-quantum authorised settlement: `PayoutGateV2` pays only with a ZK reconciliation proof **and** the station's ML-DSA-87 signature, checked on-chain by QoreChain's `pqcVerify` precompile | `evm/contracts/PayoutGateV2.sol` | ✅ on testnet: signed reconciled day PAID; forged signature REFUSED (`BadStationSignature`) |
| One chain of evidence: the signed rollup leaf (v3) carries the ZK commitment; `PayoutGateV3` rebuilds that leaf on-chain, checks the station's ML-DSA-87 signature, and pays only for a proof over the same commitment | `evm/contracts/PayoutGateV3.sol`, `src/crypto.ts` | ✅ on testnet: proof matching rollup leaf #28 PAID; proof over other figures REFUSED (`LeafSignatureInvalid`) |
| Dashboard: public watchtower view (timeline, alerts, batches, stations) + owner view decrypted locally | `dashboard/`, `rollup/src/snapshot.ts` | ✅ |

## Quick start

```bash
npm install
npm test            # unit tests + full-dataset checks
npm run generate    # writes data/sample/*.json (seed 2026)
npm run typecheck
```

Dashboard: `cd rollup && npm run snapshot`, then `npm run dashboard` from the repo root and open http://localhost:5173.

Requires Node 20+.

## Reconciliation rules

For each product (PMS, AGO, DPK), the engine runs three checks:

1. **Meters vs tanks:** litres sold, from the pump meters, against tank movement (opening dip + received − closing dip). The default tolerance is 0.5% for evaporation and dip error.
2. **Litres vs money:** Σ litres × pump price against cash + POS + transfers, for the whole station-day. The default tolerance is 0.2%.
3. **Received vs waybill:** fuel discharged into the tank against the waybill quantity. The default tolerance is 0.3%.

Each check returns `balanced`, `within_tolerance` or `discrepancy`. The report takes its worst result. Only station-days that are not `discrepancy` qualify for a payout. Money is held as integer kobo throughout.

## Demo data

All stations, figures and events in `data/` are **synthetic** and generated by a seeded script. The prices are illustrative.

- **Stations:** three fictional stations: Northgate Fuel (Lagos), Riverside Fuel (Benin) and Hilltop Fuel (Akure).
- **Period:** 30 days of reports.
- **Planted anomalies:** a meter-vs-tank loss, a cash shortfall, a short delivery against the waybill, a missing day, a duplicate submission, and one report marked for an after-submission tampering demo. They are listed in `data/sample/anomalies.json`.

The tests assert that the engine flags exactly the planted anomalies, each through the right check, and nothing else.

## Team

- **Joel Adeleye** ([@lahdlahd](https://github.com/lahdlahd)): engineering. Reconciliation engine, cryptography, rollup, sequencer, watchtower and dashboard.
- **[@Thehaneul](https://github.com/Thehaneul)**: product and launch lead. Demo video, cover image, project page, demo scenario, testing and QA, threat model co-author, and building in public.

## Credits

- [TypeScript](https://www.typescriptlang.org/), [tsx](https://github.com/privatenumber/tsx) and [Vitest](https://vitest.dev/): tooling.
- [QoreChain RDK](https://github.com/qorechain/qorechain-rdk) (`@qorechain/rdk`): the `rollup/` folder starts from the `create-qorechain-rollup` custom-rollup template.

Threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Testnet evidence: [docs/TESTNET_LOG.md](docs/TESTNET_LOG.md).

AI assistance is documented in [AI_USAGE.md](AI_USAGE.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
