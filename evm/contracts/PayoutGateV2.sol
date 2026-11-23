// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IReconcileVerifierV2 {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata pub
    ) external view returns (bool);
}

/// @title PayoutGateV2: ZK-gated, post-quantum-authorised settlement for LedgerPump.
/// @notice Pays a fuel station for a day only when BOTH hold on-chain:
///   1. a Groth16 proof that the day's figures reconcile (the chain never sees them), and
///   2. an ML-DSA-87 (FIPS 204) signature by the station's own key over this exact claim,
///      checked by QoreChain's pqcVerify precompile (0x0A01).
/// The station key is the one whose SHA-256 fingerprint the operator anchored in the
/// rollup inbox (LPS1), so the payout is tied to the same identity that signs report leaves.
contract PayoutGateV2 {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 internal constant DOMAIN = keccak256("ledgerpump/claim/v1");

    IReconcileVerifierV2 public immutable verifier;
    /// QoreChain pqcVerify precompile (0x...0A01 on testnet); injectable for local tests.
    address public immutable pqc;
    address public immutable owner;
    uint256 public immutable payoutWei;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[3] pub; // [commitment, reconciled, leafId]
    }

    struct Station {
        address payee;
        bytes32 keyFingerprint; // sha256(ML-DSA-87 public key)
    }

    /// keccak256(stationId) => station
    mapping(bytes32 => Station) public stations;
    /// leafId => paid
    mapping(uint256 => bool) public paid;
    /// leafId => the Poseidon commitment the payout was made against
    mapping(uint256 => uint256) public commitmentOf;

    event StationRegistered(string stationId, address payee, bytes32 keyFingerprint);
    event Paid(string stationId, string date, uint256 indexed leafId, uint256 commitment, address payee, uint256 amount);

    error NotOwner();
    error UnknownStation();
    error WrongStationKey();
    error BadStationSignature();
    error WrongStationDay();
    error NotReconciled();
    error AlreadyPaid();
    error InvalidProof();
    error InsufficientFunds();
    error TransferFailed();

    constructor(IReconcileVerifierV2 verifier_, address pqc_, uint256 payoutWei_) payable {
        verifier = verifier_;
        pqc = pqc_;
        owner = msg.sender;
        payoutWei = payoutWei_;
    }

    receive() external payable {}

    function registerStation(string calldata stationId, address payee, bytes32 keyFingerprint) external {
        if (msg.sender != owner) revert NotOwner();
        stations[keccak256(bytes(stationId))] = Station(payee, keyFingerprint);
        emit StationRegistered(stationId, payee, keyFingerprint);
    }

    /// Same id the circuit binds to: SHA-256("ledgerpump/leaf|station|date") mod r.
    function leafIdOf(string calldata stationId, string calldata date) public pure returns (uint256) {
        return uint256(sha256(abi.encodePacked("ledgerpump/leaf|", stationId, "|", date))) % R;
    }

    /// The exact bytes a station signs to authorise a claim. Bound to this chain,
    /// this contract, the station-day, the payee and the proof's commitment.
    function claimMessage(string calldata stationId, string calldata date, uint256 commitment)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(DOMAIN, block.chainid, address(this), stationId, date, stations[keccak256(bytes(stationId))].payee, commitment);
    }

    /// @param p Groth16 proof and its public signals [commitment, reconciled, leafId].
    /// @param stationPubkey The station's ML-DSA-87 public key (2,592 bytes).
    /// @param stationSig ML-DSA-87 signature over claimMessage(stationId, date, pub[0]).
    function claim(
        string calldata stationId,
        string calldata date,
        Proof calldata p,
        bytes calldata stationPubkey,
        bytes calldata stationSig
    ) external {
        address payee = _authorise(stationId, date, p.pub[0], stationPubkey, stationSig);
        uint256 leafId = leafIdOf(stationId, date);
        if (p.pub[2] != leafId) revert WrongStationDay();
        if (paid[leafId]) revert AlreadyPaid();
        if (p.pub[1] != 1) revert NotReconciled();
        if (!verifier.verifyProof(p.a, p.b, p.c, p.pub)) revert InvalidProof();
        if (address(this).balance < payoutWei) revert InsufficientFunds();

        paid[leafId] = true;
        commitmentOf[leafId] = p.pub[0];
        (bool ok, ) = payee.call{value: payoutWei}("");
        if (!ok) revert TransferFailed();
        emit Paid(stationId, date, leafId, p.pub[0], payee, payoutWei);
    }

    /// Station is registered, presented its registered ML-DSA-87 key, and signed this claim.
    function _authorise(
        string calldata stationId,
        string calldata date,
        uint256 commitment,
        bytes calldata stationPubkey,
        bytes calldata stationSig
    ) internal view returns (address payee) {
        Station storage st = stations[keccak256(bytes(stationId))];
        payee = st.payee;
        if (payee == address(0)) revert UnknownStation();
        if (sha256(stationPubkey) != st.keyFingerprint) revert WrongStationKey();
        bytes memory message = claimMessage(stationId, date, commitment);
        if (!_pqcVerify(stationPubkey, stationSig, message)) revert BadStationSignature();
    }

    function _pqcVerify(bytes calldata pubkey, bytes calldata sig, bytes memory message) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            pqc.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pubkey, sig, message));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}
