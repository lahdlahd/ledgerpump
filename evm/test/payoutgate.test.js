const { expect } = require("chai");
const hre = require("hardhat");
const { parseEther } = require("viem");
const fx = require("./fixtures.json");

const args = (f, pub = f.pub) => [f.stationId, f.date, f.a, f.b, f.c, pub];

async function deploy() {
  const verifier = await hre.viem.deployContract("ReconcileVerifier");
  const gate = await hre.viem.deployContract("PayoutGate", [verifier.address, parseEther("0.1")], { value: parseEther("1") });
  const [, payee] = await hre.viem.getWalletClients();
  const pc = await hre.viem.getPublicClient();
  return { verifier, gate, payee, pc };
}

// Simulate the call and return the decoded custom-error name (or "no revert").
async function revertName(contract, fn, fnArgs, opts) {
  try {
    await contract.simulate[fn](fnArgs, opts);
    return "no revert";
  } catch (e) {
    let c = e;
    while (c) {
      if (c.data?.errorName) return c.data.errorName;
      const m = String(c.message || "").match(/custom error '(\w+)\(/);
      if (m) return m[1];
      c = c.cause;
    }
    return String(e.shortMessage || e.message);
  }
}

describe("ReconcileVerifier (Groth16 on BN254)", () => {
  it("accepts real proofs and rejects a tampered public signal", async () => {
    const { verifier } = await deploy();
    expect(await verifier.read.verifyProof([fx.clean.a, fx.clean.b, fx.clean.c, fx.clean.pub])).to.equal(true);
    expect(await verifier.read.verifyProof([fx.theft.a, fx.theft.b, fx.theft.c, fx.theft.pub])).to.equal(true); // valid, says 0
    const flipped = [fx.theft.pub[0], "1", fx.theft.pub[2]];
    expect(await verifier.read.verifyProof([fx.theft.a, fx.theft.b, fx.theft.c, flipped])).to.equal(false);
  });
});

describe("PayoutGate", () => {
  it("pays a reconciled station-day once, to the registered payee", async () => {
    const { gate, payee, pc } = await deploy();
    await gate.write.registerStation(["NGT-LAG-01", payee.account.address]);
    const before = await pc.getBalance({ address: payee.account.address });
    await gate.write.claim(args(fx.clean));
    expect((await pc.getBalance({ address: payee.account.address })) - before).to.equal(parseEther("0.1"));
    expect(await revertName(gate, "claim", args(fx.clean))).to.equal("AlreadyPaid");
  });

  it("refuses the theft day: the proof is valid but says reconciled = 0", async () => {
    const { gate, payee } = await deploy();
    await gate.write.registerStation(["NGT-LAG-01", payee.account.address]);
    expect(await revertName(gate, "claim", args(fx.theft))).to.equal("NotReconciled");
  });

  it("refuses a forged 'reconciled' flag", async () => {
    const { gate, payee } = await deploy();
    await gate.write.registerStation(["NGT-LAG-01", payee.account.address]);
    expect(await revertName(gate, "claim", args(fx.theft, [fx.theft.pub[0], "1", fx.theft.pub[2]]))).to.equal("InvalidProof");
  });

  it("refuses a proof replayed for a different station-day", async () => {
    const { gate, payee } = await deploy();
    await gate.write.registerStation(["NGT-LAG-01", payee.account.address]);
    expect(await revertName(gate, "claim", ["NGT-LAG-01", "2026-11-02", fx.clean.a, fx.clean.b, fx.clean.c, fx.clean.pub])).to.equal("WrongStationDay");
  });

  it("refuses unknown stations and non-owner registration", async () => {
    const { gate, payee } = await deploy();
    expect(await revertName(gate, "claim", args(fx.clean))).to.equal("UnknownStation");
    expect(await revertName(gate, "registerStation", ["NGT-LAG-01", payee.account.address], { account: payee.account })).to.equal("NotOwner");
  });

  it("leafIdOf matches the circuit's station-day id", async () => {
    const { gate } = await deploy();
    expect(await gate.read.leafIdOf([fx.clean.stationId, fx.clean.date])).to.equal(BigInt(fx.clean.pub[2]));
    expect(await gate.read.leafIdOf([fx.clean2.stationId, fx.clean2.date])).to.equal(BigInt(fx.clean2.pub[2]));
  });

  it("reports gas for one claim (proof check + payout)", async () => {
    const { gate, payee, pc } = await deploy();
    await gate.write.registerStation(["NGT-LAG-01", payee.account.address]);
    const r = await pc.getTransactionReceipt({ hash: await gate.write.claim(args(fx.clean)) });
    console.log(`      claim gas used: ${r.gasUsed}`);
    expect(Number(r.gasUsed)).to.be.lessThan(600000);
  });
});
