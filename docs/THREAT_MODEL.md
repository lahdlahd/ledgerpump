# LedgerPump threat model

LedgerPump settles fuel-station reconciliation on a QoreChain rollup. This document states what we protect, against whom, how, and what we deliberately do not claim. Every on-chain mechanism listed as "verified" has a transaction in [TESTNET_LOG.md](TESTNET_LOG.md).

## Assets
1. **Confidentiality of station figures:** sales, stock, deliveries, payments.
2. **Integrity of each submitted report:** it can't be edited, swapped or deleted after submission without detection.
3. **Authenticity:** a report really comes from the station that claims it.
4. **Correct settlement:** payouts only for station-days that reconciled, and rollup state roots that match the chain's canonical execution.
5. **Availability of the record:** the operator can't silently suppress a station's submission.

## Actors
| Actor | Holds | Trust |
|---|---|---|
| Station | ML-DSA-87 signing key (reports), ML-DSA-44 L2 key (payouts) | Trusted for its own key only; may lie about its figures (see out of scope) |
| Owner / auditor | ML-KEM-1024 decryption key, registered in QoreChain's KEM registry | Trusted to read; not trusted to rewrite history |
| Operator | Rollup creator, batch submitter, treasury key | **Not trusted:** every claim it makes is independently checkable |
| Public / watchtower | Nothing secret | Anyone can run it |
| Attacker with a quantum computer | Can break ECDSA/secp256k1 and classical KEMs | Primary long-term adversary |

## Threats and mitigations
| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | "Harvest now, decrypt later": recorded ciphertext broken by a future quantum computer | Reports are sealed with AES-256-GCM under a fresh per-report key, wrapped with **ML-KEM-1024** (FIPS 203) per reader | ✅ implemented, tested |
| T2 | Forged report or forged status ("balanced") | Leaf `(station, date, ciphertextHash, status)` signed with **ML-DSA-87** (FIPS 204), bound to chain ID and rollup ID; station key fingerprints anchored on-chain by the operator (`LPS1`) | ✅ tested; anchors on testnet |
| T3 | Classical key stolen or quantum-broken; attacker submits transactions | QoreChain requires **hybrid** signatures (secp256k1 + ML-DSA-87) on every native transaction; the chain logs `pqc_hybrid_verify: verified` | ✅ on testnet |
| T4 | Report edited or replaced after submission | The chain stores SHA-256 of every inbox post; the leaf commits to the ciphertext hash; the watchtower recomputes it from the store | ✅ caught a real overwrite on testnet (inbox #6) |
| T5 | Report deleted from storage | The watchtower flags `ciphertext_missing` against the on-chain commitment | ✅ on testnet |
| T6 | Operator censors a station | The rollup uses **based sequencing**: any account can post to the inbox, and batches must consume it in order | ✅ by chain design |
| T7 | Submitter publishes a wrong state or withdrawals root (e.g. to steal from the pool) | qledger-v1 roots are canonical. The watchtower re-executes every batch, and `--challenge` submits a fraud proof; the chain rejects the batch and slashes the submitter's 1,000 QOR bond | ✅ re-execution on testnet; forged-batch demo: `npm run bad-batch` |
| T8 | Payout for a station-day that didn't reconcile | Rollup path: the treasury signs transfers only for watchtower-verified, non-discrepancy, first submissions, auditable against the inbox. ZK path: `PayoutGate` pays only when a Groth16 proof with `reconciled = 1` verifies on-chain, once per (station, date), to the registered payee | ✅ chain-enforced on the ZK path (theft day refused on testnet, tx `0xac57ca44…`); rollup path stays off-chain and auditable |
| T9 | Station lies about its own status | The auditor tier decrypts the report and re-runs reconciliation; a mismatch is evidence the signed leaf was false | ✅ engine tested; auditor tooling: `read-report` |
| T10 | Duplicate / replayed submissions | Flagged by the watchtower from `(station, date)`; payouts skip duplicates; signatures are bound to chain and rollup | ✅ on testnet (inbox #10) |
| T12 | Someone presents a fake "this batch settled" claim | Settlement receipts are verified by re-reading the layer, batch root, anchor and creator key from the chain, and checking the creator's ML-DSA-87 anchor signature; a receipt file alone is never trusted | ✅ receipts for batches 0–3 verified on testnet |
| T13 | Forged ZK proof via a compromised trusted setup | The demo Groth16 setup is single-party (2^14 ptau + one contribution). Whoever holds the toxic waste could forge proofs | ⚠️ demo only. Production needs a multi-party ceremony (or a transparent proof system) |
| T14 | Station proves over figures different from its encrypted report | The Poseidon commitment is a public signal; the auditor decrypts the report, recomputes the commitment and flags a mismatch | ⚠️ checked by the auditor, not the chain. Future: anchor the commitment in the signed rollup leaf |
| T15 | Someone with a valid proof claims a station's payout without the station's consent (stolen proof, rogue relayer, compromised operator) | `PayoutGateV2` also requires the station's ML-DSA-87 signature over a message bound to chain, contract, station-day, payee and commitment. It's checked on-chain by the `pqcVerify` precompile, against the key fingerprint registered for the station (the same key that signs its rollup leaves) | ✅ on testnet: forged signature refused (`BadStationSignature`, tx `0xdd2b65fa…`) |
| T11 | Withdrawal paid twice or to the wrong address | The chain checks the Merkle proof against the finalised batch's withdrawals root and tracks withdrawal indices | ✅ by chain design; first claim executed on testnet |

## What is public
Station ID, date, reconciliation status, payout amount, ciphertext size and timing. This reveals *whether* a station balanced, not its figures. **Future:** commit the status as a salted hash revealed only to readers.

## Out of scope (stated honestly)
- **Truth of the original figures.** LedgerPump proves a report wasn't changed after submission and that the reconciliation is consistent. It can't prove the manager typed true meter readings. **Future:** signed feeds from pump meters, automatic tank gauges and POS terminals.
- **Key management on devices.** Keys live in local files for this demo. Production needs hardware-backed storage and rotation.
- **Real money.** Testnet QOR only; no naira payments; not deployed on mainnet.
- **Availability of the ciphertext store.** The store is a folder in the repo for the demo; production needs replicated storage.
- **Operator as owner.** In the demo, the owner and the operator are the same account. In production they would be separate.
