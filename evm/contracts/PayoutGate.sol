// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IReconcileVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata pub
    ) external view returns (bool);
}

/// @title PayoutGate: reconciliation-gated settlement for LedgerPump.
/// @notice Pays a fuel station for a day ONLY if it presents a valid
/// zero-knowledge proof that the day's figures reconcile (meters vs tanks,
/// litres vs money, received vs waybill). The chain never sees the figures.
/// Each station-day can be paid once, and only to the station's registered
/// payee, so anyone may relay a claim.
contract PayoutGate {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IReconcileVerifier public immutable verifier;
    address public immutable owner;
    uint256 public immutable payoutWei;

    /// keccak256(stationId) => payee
    mapping(bytes32 => address) public payeeOf;
    /// leafId => paid
    mapping(uint256 => bool) public paid;
    /// leafId => the Poseidon commitment the payout was made against
    mapping(uint256 => uint256) public commitmentOf;

    event StationRegistered(string stationId, address payee);
    event Paid(string stationId, string date, uint256 indexed leafId, uint256 commitment, address payee, uint256 amount);

    error NotOwner();
    error UnknownStation();
    error WrongStationDay();
    error NotReconciled();
    error AlreadyPaid();
    error InvalidProof();
    error InsufficientFunds();
    error TransferFailed();

    constructor(IReconcileVerifier verifier_, uint256 payoutWei_) payable {
        verifier = verifier_;
        owner = msg.sender;
        payoutWei = payoutWei_;
    }

    receive() external payable {}

    function registerStation(string calldata stationId, address payee) external {
        if (msg.sender != owner) revert NotOwner();
        payeeOf[keccak256(bytes(stationId))] = payee;
        emit StationRegistered(stationId, payee);
    }

    /// Same id the circuit binds to: SHA-256("ledgerpump/leaf|station|date") mod r.
    function leafIdOf(string calldata stationId, string calldata date) public pure returns (uint256) {
        return uint256(sha256(abi.encodePacked("ledgerpump/leaf|", stationId, "|", date))) % R;
    }

    /// @param pub Public signals [commitment, reconciled, leafId].
    function claim(
        string calldata stationId,
        string calldata date,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata pub
    ) external {
        address payee = payeeOf[keccak256(bytes(stationId))];
        if (payee == address(0)) revert UnknownStation();
        uint256 leafId = leafIdOf(stationId, date);
        if (pub[2] != leafId) revert WrongStationDay();
        if (pub[1] != 1) revert NotReconciled();
        if (paid[leafId]) revert AlreadyPaid();
        if (!verifier.verifyProof(a, b, c, pub)) revert InvalidProof();
        if (address(this).balance < payoutWei) revert InsufficientFunds();

        paid[leafId] = true;
        commitmentOf[leafId] = pub[0];
        (bool ok, ) = payee.call{value: payoutWei}("");
        if (!ok) revert TransferFailed();
        emit Paid(stationId, date, leafId, pub[0], payee, payoutWei);
    }
}
