// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IReconcileVerifierV3 {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata pub
    ) external view returns (bool);
}

/// @title PayoutGateV3: settlement bound to the station's signed rollup leaf.
/// @notice A station's daily report goes into the LedgerPump rollup as a signed leaf
/// (leaf v3): station, date, SHA-256 of the encrypted report, reconciliation status and
/// the Poseidon commitment its ZK proof is made against, signed with the station's
/// ML-DSA-87 key. This contract pays a station-day only when:
///   1. the leaf, rebuilt here byte for byte with the proof's commitment, carries a valid
///      ML-DSA-87 signature by the station's registered key (QoreChain pqcVerify, 0x0A01),
///   2. the signed leaf doesn't say "discrepancy", and
///   3. the Groth16 proof over that same commitment says the day reconciled.
/// So the payout, the proof, the rollup leaf and the encrypted report are one chain of
/// evidence: a proof over any other figures fails the signature check.
contract PayoutGateV3 {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct Leaf {
        string stationId;
        string date;
        string ciphertextHash; // lowercase hex SHA-256 of the encrypted report
        string status; // "balanced" | "within_tolerance" | "discrepancy"
    }

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[3] pub; // [commitment, reconciled, leafId]
    }

    struct Station {
        address payee;
        bytes32 keyFingerprint; // sha256(ML-DSA-87 public key), as anchored in the rollup (LPS1)
    }

    IReconcileVerifierV3 public immutable verifier;
    address public immutable pqc;
    address public immutable owner;
    uint256 public immutable payoutWei;
    /// The rollup the leaves are signed for (part of the signed message).
    string public chainName;
    string public rollupId;

    mapping(bytes32 => Station) public stations;
    mapping(uint256 => bool) public paid;
    /// leafId => SHA-256 of the encrypted report the payout was made for
    mapping(uint256 => bytes32) public reportHashOf;

    event StationRegistered(string stationId, address payee, bytes32 keyFingerprint);
    event Paid(string stationId, string date, uint256 indexed leafId, uint256 commitment, string ciphertextHash, address payee, uint256 amount);

    error NotOwner();
    error UnknownStation();
    error WrongStationKey();
    error LeafSignatureInvalid();
    error LeafSaysDiscrepancy();
    error WrongStationDay();
    error NotReconciled();
    error AlreadyPaid();
    error InvalidProof();
    error InsufficientFunds();
    error TransferFailed();

    constructor(
        IReconcileVerifierV3 verifier_,
        address pqc_,
        uint256 payoutWei_,
        string memory chainName_,
        string memory rollupId_
    ) payable {
        verifier = verifier_;
        pqc = pqc_;
        owner = msg.sender;
        payoutWei = payoutWei_;
        chainName = chainName_;
        rollupId = rollupId_;
    }

    receive() external payable {}

    function registerStation(string calldata stationId, address payee, bytes32 keyFingerprint) external {
        if (msg.sender != owner) revert NotOwner();
        stations[keccak256(bytes(stationId))] = Station(payee, keyFingerprint);
        emit StationRegistered(stationId, payee, keyFingerprint);
    }

    function leafIdOf(string calldata stationId, string calldata date) public pure returns (uint256) {
        return uint256(sha256(abi.encodePacked("ledgerpump/leaf|", stationId, "|", date))) % R;
    }

    /// The exact bytes the station signed when it posted the leaf to the rollup:
    /// "ledgerpump/leaf/v3|<chain>|<rollup>|" + canonical JSON of the leaf (keys sorted).
    function leafMessage(Leaf calldata leaf, uint256 commitment) public view returns (bytes memory) {
        bytes memory json = abi.encodePacked(
            '{"ciphertextHash":"', leaf.ciphertextHash,
            '","date":"', leaf.date,
            '","stationId":"', leaf.stationId,
            '","status":"', leaf.status,
            '","v":3,"zkCommitment":"', _dec(commitment), '"}'
        );
        return abi.encodePacked("ledgerpump/leaf/v3|", chainName, "|", rollupId, "|", json);
    }

    function claim(Leaf calldata leaf, Proof calldata p, bytes calldata stationPubkey, bytes calldata leafSig) external {
        address payee = _checkLeaf(leaf, p.pub[0], stationPubkey, leafSig);
        uint256 leafId = leafIdOf(leaf.stationId, leaf.date);
        if (p.pub[2] != leafId) revert WrongStationDay();
        if (paid[leafId]) revert AlreadyPaid();
        if (p.pub[1] != 1) revert NotReconciled();
        if (!verifier.verifyProof(p.a, p.b, p.c, p.pub)) revert InvalidProof();
        if (address(this).balance < payoutWei) revert InsufficientFunds();

        paid[leafId] = true;
        reportHashOf[leafId] = _hexToBytes32(leaf.ciphertextHash);
        (bool ok, ) = payee.call{value: payoutWei}("");
        if (!ok) revert TransferFailed();
        emit Paid(leaf.stationId, leaf.date, leafId, p.pub[0], leaf.ciphertextHash, payee, payoutWei);
    }

    /// Registered station, its registered key, a valid ML-DSA-87 signature on the rebuilt leaf,
    /// and a leaf that doesn't declare a discrepancy.
    function _checkLeaf(Leaf calldata leaf, uint256 commitment, bytes calldata pubkey, bytes calldata sig)
        internal
        view
        returns (address payee)
    {
        Station storage st = stations[keccak256(bytes(leaf.stationId))];
        payee = st.payee;
        if (payee == address(0)) revert UnknownStation();
        if (sha256(pubkey) != st.keyFingerprint) revert WrongStationKey();
        bytes memory message = leafMessage(leaf, commitment);
        if (!_pqcVerify(pubkey, sig, message)) revert LeafSignatureInvalid();
        if (keccak256(bytes(leaf.status)) == keccak256("discrepancy")) revert LeafSaysDiscrepancy();
    }

    function _pqcVerify(bytes calldata pubkey, bytes calldata sig, bytes memory message) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            pqc.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pubkey, sig, message));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _dec(uint256 v) internal pure returns (bytes memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory out = new bytes(len);
        for (; v != 0; v /= 10) out[--len] = bytes1(uint8(48 + (v % 10)));
        return out;
    }

    function _hexToBytes32(string calldata h) internal pure returns (bytes32 out) {
        bytes calldata b = bytes(h);
        if (b.length != 64) return bytes32(0);
        for (uint256 i = 0; i < 64; i++) {
            uint8 c = uint8(b[i]);
            uint8 n = c >= 97 ? c - 87 : (c >= 65 ? c - 55 : c - 48);
            out |= bytes32(uint256(n) << (4 * (63 - i)));
        }
    }
}
