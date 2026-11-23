const { expect } = require("chai");
const hre = require("hardhat");
const { parseEther, sha256, hexToBytes } = require("viem");
const fx = require("./fixtures-v3.json");

let mldsa;
before(async () => {
  ({ ml_dsa87: mldsa } = await import("@noble/post-quantum/ml-dsa.js"));
});

async function deploy() {
  const verifier = await hre.viem.deployContract("ReconcileVerifier");
  const mock = await hre.viem.deployContract("MockPqcVerify");
  const gate = await hre.viem.deployContract(
    "PayoutGateV3",
    [verifier.address, mock.address, parseEther("0.1"), fx.ctx.chainId, fx.ctx.rollupId],
    { value: parseEther("1") },
  );
  const [, payee, relayer] = await hre.viem.getWalletClients();
  const pc = await hre.viem.getPublicClient();
  for (const id of ["NGT-LAG-01", "HLT-AKR-01"]) await gate.write.registerStation([id, payee.account.address, sha256(fx.stationPubkey)]);
  // Register with the mock only the signatures @noble/post-quantum verifies over the exact message.
  for (const k of ["clean", "theft", "theftLying", "clean2"]) {
    const f = fx[k];
    if (mldsa.verify(hexToBytes(f.signature), hexToBytes(f.message), hexToBytes(fx.stationPubkey))) {
      await mock.write.allow([fx.stationPubkey, f.signature, f.message]);
    }
  }
  return { gate, mock, payee, relayer, pc };
}

const args = (f, o = {}) => [o.leaf ?? f.leaf, o.proof ?? f.proof, o.pubkey ?? fx.stationPubkey, o.sig ?? f.signature];

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

describe("PayoutGateV3 (payout bound to the station's signed rollup leaf)", () => {
  it("rebuilds the signed v3 rollup leaf byte for byte (same bytes src/crypto.ts signs)", async () => {
    const { gate } = await deploy();
    for (const k of ["clean", "theft", "clean2"]) {
      const f = fx[k];
      expect(await gate.read.leafMessage([f.leaf, BigInt(f.proof.pub[0])])).to.equal(f.message);
    }
  });

  it("pays a reconciled day whose signed leaf commits to the proof, once, even when relayed", async () => {
    const t = await deploy();
    const before = await t.pc.getBalance({ address: t.payee.account.address });
    await t.gate.write.claim(args(fx.clean), { account: t.relayer.account });
    expect((await t.pc.getBalance({ address: t.payee.account.address })) - before).to.equal(parseEther("0.1"));
    expect(await t.gate.read.reportHashOf([BigInt(fx.clean.proof.pub[2])])).to.equal("0x" + fx.clean.leaf.ciphertextHash);
    expect(await revertName(t.gate, "claim", args(fx.clean))).to.equal("AlreadyPaid");
  });

  it("refuses a proof over different figures than the signed leaf (commitment mismatch)", async () => {
    const t = await deploy();
    // clean's signed leaf with clean2's proof: the rebuilt leaf has the wrong commitment.
    expect(await revertName(t.gate, "claim", args(fx.clean, { proof: fx.clean2.proof }))).to.equal("LeafSignatureInvalid");
  });

  it("refuses a leaf that was edited after signing (e.g. a different report hash)", async () => {
    const t = await deploy();
    const edited = { ...fx.clean.leaf, ciphertextHash: "00".repeat(32) };
    expect(await revertName(t.gate, "claim", args(fx.clean, { leaf: edited }))).to.equal("LeafSignatureInvalid");
  });

  it("refuses the theft day: the station's own signed leaf says discrepancy", async () => {
    const t = await deploy();
    expect(await revertName(t.gate, "claim", args(fx.theft))).to.equal("LeafSaysDiscrepancy");
  });

  it("refuses the theft day even if the station lies in its leaf: the proof says not reconciled", async () => {
    const t = await deploy();
    expect(await revertName(t.gate, "claim", args(fx.theftLying))).to.equal("NotReconciled");
  });

  it("refuses a key that isn't the station's registered key", async () => {
    const t = await deploy();
    expect(await revertName(t.gate, "claim", args(fx.clean, { pubkey: "0x" + "11".repeat(2592) }))).to.equal("WrongStationKey");
  });

  it("refuses unknown stations and non-owner registration", async () => {
    const t = await deploy();
    expect(await revertName(t.gate, "claim", args(fx.clean, { leaf: { ...fx.clean.leaf, stationId: "XXX-000-00" } }))).to.equal("UnknownStation");
    expect(await revertName(t.gate, "registerStation", ["X", t.payee.account.address, sha256("0x00")], { account: t.payee.account })).to.equal("NotOwner");
  });

  it("reports gas for one claim (mock precompile)", async () => {
    const t = await deploy();
    const r = await t.pc.getTransactionReceipt({ hash: await t.gate.write.claim(args(fx.clean2)) });
    console.log(`      claim gas used (local, mock pqcVerify): ${r.gasUsed}`);
  });
});
