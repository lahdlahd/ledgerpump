pragma circom 2.1.6;

// LedgerPump zero-knowledge reconciliation.
//
// A station proves that its daily figures pass LedgerPump's three-way
// reconciliation — meters vs tanks, litres vs money, received vs waybill, for
// PMS, AGO and DPK — without revealing any figure. The proof is bound to a
// Poseidon commitment of the figures (plus a secret salt) and to the
// station-day it is for.
//
// Units (integers only): litres x10 (one decimal), prices in kobo per litre,
// money in kobo. Tolerances match src/reconcile.ts:
//   meters vs tanks     |d| <= 0.5% of litres sold      or |d| <= 0.5 L
//   received vs waybill |d| <= 0.3% of waybill          or |d| <= 0.5 L
//   litres vs money     |d| <= 0.2% of expected revenue or |d| <= N100
//
// Public:  leafId (station-day), commitment, reconciled (output, 1 or 0)

include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// 1 if |a - b| * den <= num * base, or |a - b| <= band. a, b, base < 2^48.
template WithinTolerance(num, den, band) {
    signal input a;
    signal input b;
    signal input base;
    signal output ok;

    component ge = GreaterEqThan(64);
    ge.in[0] <== a;
    ge.in[1] <== b;
    signal pos <== ge.out * (a - b);
    signal absd <== pos + (1 - ge.out) * (b - a);

    component rel = LessEqThan(64);
    rel.in[0] <== absd * den;
    rel.in[1] <== base * num;

    component abs = LessEqThan(64);
    abs.in[0] <== absd;
    abs.in[1] <== band;

    // OR
    ok <== rel.out + abs.out - rel.out * abs.out;
}

template Reconcile(P, PUMPS) {
    // ---- private figures ----
    signal input openMeter[P][PUMPS];
    signal input closeMeter[P][PUMPS];
    signal input openDip[P];
    signal input closeDip[P];
    signal input received[P];
    signal input waybill[P];
    signal input price[P];
    signal input cash;
    signal input pos;
    signal input transfer;
    signal input salt;

    // ---- public ----
    signal input leafId;
    signal output commitment;
    signal output reconciled;

    // Range checks keep every figure far below the field size (no wraparound).
    component rc[P * (2 * PUMPS + 5) + 3];
    var k = 0;
    for (var p = 0; p < P; p++) {
        for (var i = 0; i < PUMPS; i++) {
            rc[k] = Num2Bits(48); rc[k].in <== openMeter[p][i]; k++;
            rc[k] = Num2Bits(48); rc[k].in <== closeMeter[p][i]; k++;
        }
        rc[k] = Num2Bits(48); rc[k].in <== openDip[p]; k++;
        rc[k] = Num2Bits(48); rc[k].in <== closeDip[p]; k++;
        rc[k] = Num2Bits(48); rc[k].in <== received[p]; k++;
        rc[k] = Num2Bits(48); rc[k].in <== waybill[p]; k++;
        rc[k] = Num2Bits(48); rc[k].in <== price[p]; k++;
    }
    rc[k] = Num2Bits(48); rc[k].in <== cash; k++;
    rc[k] = Num2Bits(48); rc[k].in <== pos; k++;
    rc[k] = Num2Bits(48); rc[k].in <== transfer; k++;

    // Meters never run backwards.
    component fwd[P][PUMPS];
    signal soldAcc[P][PUMPS + 1];
    for (var p = 0; p < P; p++) {
        soldAcc[p][0] <== 0;
        for (var i = 0; i < PUMPS; i++) {
            fwd[p][i] = GreaterEqThan(48);
            fwd[p][i].in[0] <== closeMeter[p][i];
            fwd[p][i].in[1] <== openMeter[p][i];
            fwd[p][i].out === 1;
            soldAcc[p][i + 1] <== soldAcc[p][i] + closeMeter[p][i] - openMeter[p][i];
        }
    }

    // Check 1: meters vs tanks. openDip + received == closeDip + sold (within tolerance).
    // Check 3: received vs waybill.
    component tank[P];
    component wb[P];
    signal revenue[P];       // litres x10 * kobo/L = kobo x10
    signal revAcc[P + 1];
    signal okAcc[2 * P + 1];
    revAcc[0] <== 0;
    okAcc[0] <== 1;
    for (var p = 0; p < P; p++) {
        tank[p] = WithinTolerance(5, 1000, 5);
        tank[p].a <== openDip[p] + received[p];
        tank[p].b <== closeDip[p] + soldAcc[p][PUMPS];
        tank[p].base <== soldAcc[p][PUMPS];

        wb[p] = WithinTolerance(3, 1000, 5);
        wb[p].a <== received[p];
        wb[p].b <== waybill[p];
        wb[p].base <== waybill[p];

        okAcc[2 * p + 1] <== okAcc[2 * p] * tank[p].ok;
        okAcc[2 * p + 2] <== okAcc[2 * p + 1] * wb[p].ok;

        revenue[p] <== soldAcc[p][PUMPS] * price[p];
        revAcc[p + 1] <== revAcc[p] + revenue[p];
    }

    // Check 2: litres vs money (in kobo x10).
    component money = WithinTolerance(2, 1000, 100000);
    money.a <== (cash + pos + transfer) * 10;
    money.b <== revAcc[P];
    money.base <== revAcc[P];

    reconciled <== okAcc[2 * P] * money.ok;

    // Commitment: Poseidon over every figure, the salt and the station-day.
    var N = P * (2 * PUMPS + 5) + 4;
    signal flat[N];
    var j = 0;
    for (var p = 0; p < P; p++) {
        for (var i = 0; i < PUMPS; i++) { flat[j] <== openMeter[p][i]; j++; flat[j] <== closeMeter[p][i]; j++; }
        flat[j] <== openDip[p]; j++;
        flat[j] <== closeDip[p]; j++;
        flat[j] <== received[p]; j++;
        flat[j] <== waybill[p]; j++;
        flat[j] <== price[p]; j++;
    }
    flat[j] <== cash; j++;
    flat[j] <== pos; j++;
    flat[j] <== transfer; j++;
    flat[j] <== salt; j++;

    // Hash in chunks of 16.
    var CH = (N + 15) \ 16;
    component h[CH];
    for (var c = 0; c < CH; c++) {
        var len = (c == CH - 1) ? N - 16 * c : 16;
        h[c] = Poseidon(len);
        for (var t = 0; t < len; t++) h[c].inputs[t] <== flat[16 * c + t];
    }
    component top = Poseidon(CH + 1);
    for (var c = 0; c < CH; c++) top.inputs[c] <== h[c].out;
    top.inputs[CH] <== leafId;
    commitment <== top.out;
}

component main { public [leafId] } = Reconcile(3, 4);
