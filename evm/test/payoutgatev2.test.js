const { expect } = require("chai");
const hre = require("hardhat");
const { parseEther, bytesToHex, hexToBytes, sha256 } = require("viem");
const fx = require("./fixtures.json");

// Throwaway test keys (fixed seeds); real station keys live in rollup/keys/ only.
const seed = (n) => new Uint8Array(32).fill(n);
let mldsa;
before(async () => {
  ({ ml_dsa87: mldsa } = await import("@noble/post-quantum/ml-dsa.js"));
});

async function deploy() {
  const verifier = await hre.viem.deployContract("ReconcileVerifier");
  const mock = await hre.viem.deployContract("MockPqcVerify");
  const gate = await hre.viem.deployContract("PayoutGateV2", [verifier.address, mock.address, parseEther("0.1")], { value: parseEther("1") });
  const [, payee, relayer] = await hre.viem.getWalletClients();
  const pc = await hre.viem.getPublicClient();
  const station = mldsa.keygen(seed(11));
  await gate.write.registerStation(["NGT-LAG-01", payee.account.address, sha256(station.publicKey)]);
  return { gate, mock, payee, relayer, pc, station };
}

// Sign the contract's own claim message with ML-DSA-87. Only signatures that
// @noble/post-quantum verifies are registered with the local mock precompile.
async function sign(t, kp, f, opts = {}) {
  const msg = await t.gate.read.claimMessage([opts.stationId ?? f.stationId, opts.date ?? f.date, BigInt(f.pub[0])]);
  let sig = mldsa.sign(hexToBytes(msg), kp.secretKey);
  if (opts.tamper) { sig = sig.slice(); sig[10] ^= 1; }
  if (mldsa.verify(sig, hexToBytes(msg), kp.publicKey)) await t.mock.write.allow([bytesToHex(kp.publicKey), bytesToHex(sig), msg]);
  return { pk: bytesToHex(kp.publicKey), sig: bytesToHex(sig) };
}

const args = (f, s, o = {}) => [o.stationId ?? f.stationId, o.date ?? f.date, { a: f.a, b: f.b, c: f.c, pub: o.pub ?? f.pub }, s.pk, s.sig];

async function revertName(contract, fn, fnArgs, opts) {
  try {
    await contract.simulate[fn](fnArgs, opts);
    return "no revert";
  } catch (e) {
    for (let c = e; c; c = c.cause) {
      if (c.data?.errorName) return c.data.errorName;
      const m = String(c.message || "").match(/custom error '(\w+)\(/);
      if (m) return m[1];
    }
    return String(e.shortMessage || e.message);
  }
}

describe("PayoutGateV2 (ZK proof + ML-DSA-87 station signature)", () => {
  it("pays a reconciled day signed by the station's key, once, to its payee, even when relayed", async () => {
    const t = await deploy();
    const s = await sign(t, t.station, fx.clean);
    const before = await t.pc.getBalance({ address: t.payee.account.address });
    await t.gate.write.claim(args(fx.clean, s), { account: t.relayer.account });
    expect((await t.pc.getBalance({ address: t.payee.account.address })) - before).to.equal(parseEther("0.1"));
    expect(await revertName(t.gate, "claim", args(fx.clean, s))).to.equal("AlreadyPaid");
  });

  it("still refuses the theft day when the station signs it", async () => {
    const t = await deploy();
    const s = await sign(t, t.station, fx.theft);
    expect(await revertName(t.gate, "claim", args(fx.theft, s))).to.equal("NotReconciled");
  });

  it("refuses a valid proof signed by a key that isn't the station's", async () => {
    const t = await deploy();
    const s = await sign(t, mldsa.keygen(seed(99)), fx.clean);
    expect(await revertName(t.gate, "claim", args(fx.clean, s))).to.equal("WrongStationKey");
  });

  it("refuses a tampered station signature", async () => {
    const t = await deploy();
    const s = await sign(t, t.station, fx.clean, { tamper: true });
    expect(await revertName(t.gate, "claim", args(fx.clean, s))).to.equal("BadStationSignature");
  });

  it("refuses a signature for one claim reused on another (bound to commitment and day)", async () => {
    const t = await deploy();
    const s = await sign(t, t.station, fx.clean2);
    expect(await revertName(t.gate, "claim", args(fx.clean, s))).to.equal("BadStationSignature");
  });

  it("refuses a forged 'reconciled' flag even with a valid signature", async () => {
    const t = await deploy();
    const forged = { ...fx.theft, pub: [fx.theft.pub[0], "1", fx.theft.pub[2]] };
    const s = await sign(t, t.station, forged);
    expect(await revertName(t.gate, "claim", args(forged, s))).to.equal("InvalidProof");
  });

  it("refuses unknown stations and non-owner registration", async () => {
    const t = await deploy();
    const s = await sign(t, t.station, fx.clean);
    expect(await revertName(t.gate, "claim", args(fx.clean, s, { stationId: "XXX-000-00" }))).to.equal("UnknownStation");
    expect(await revertName(t.gate, "registerStation", ["X", t.payee.account.address, sha256("0x00")], { account: t.payee.account })).to.equal("NotOwner");
  });

  it("reports gas for one claim (mock precompile; testnet adds the real ML-DSA-87 check)", async () => {
    const t = await deploy();
    const s = await sign(t, t.station, fx.clean);
    const r = await t.pc.getTransactionReceipt({ hash: await t.gate.write.claim(args(fx.clean, s)) });
    console.log(`      claim gas used (local, mock pqcVerify): ${r.gasUsed}`);
  });
});
