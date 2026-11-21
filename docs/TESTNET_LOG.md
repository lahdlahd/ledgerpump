# Testnet log

Every on-chain claim LedgerPump makes is backed by a transaction on QoreChain testnet (`qorechain-diana`). This log records each step with its transaction hash.

Operator account: `qor1n93a8mz6vdjhre7f8ehs2fdugxvqjpcu77k8zn`

| Date (UTC) | Step | Tx hash | Height | Result |
|---|---|---|---|---|
| 2026-11-21 | Operator's ML-DSA-87 key registered (canonical), in its own tx, by the RDK client | — | — | ✅ (RDK log) |
| 2026-11-21 | `MsgCreateRollup`: rollup `ledgerpump`, profile `custom`, optimistic settlement. 10,000 QOR stake transferred, 100 QOR burned (`rollup_create`), plus a further 1,000 QOR transfer (layer stake) | `75116C5E7FEF47A77C1067365C0343BC0FC8491463D215EA64CD981C75E0D28A` | 10508000 | ✅ code 0 |
