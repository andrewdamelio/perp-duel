// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DuelEscrow
/// @notice Holds both stakes of a 1v1 perp duel and pays the winner.
///
/// No positions are opened anywhere. Each player commits to one "card" (asset, side,
/// leverage and an optional hidden win condition) by posting a salted hash alongside
/// their stake. A referee watches Hyperliquid prices off-chain, scores both synthetic
/// positions, and signs the result. Settlement reveals both cards, checks them against
/// the commitments, checks the referee's signature, and pays out.
///
/// What the referee can and cannot do:
///  - It cannot change which card a player picked: reveals must match the commitments.
///  - It cannot take the pot: funds only ever go to the two players.
///  - It cannot stall forever: after a grace period either player can refund both stakes.
///  - It is trusted for the scores themselves, since liquidations depend on the price path.
contract DuelEscrow is EIP712, ReentrancyGuard {
    enum Status {
        None,
        Open,
        Live,
        Settled,
        Refunded
    }

    struct Duel {
        address playerA;
        address playerB;
        uint96 stake;
        uint64 duration;
        uint64 openedAt;
        uint64 startedAt;
        Status status;
        bytes32 commitA;
        bytes32 commitB;
    }

    struct Reveal {
        bytes32 card;
        bytes32 salt;
    }

    bytes32 private constant RESULT_TYPEHASH =
        keccak256("Result(bytes32 duelId,bytes32 cardA,bytes32 cardB,int32 scoreA,int32 scoreB)");

    uint64 public constant MIN_DURATION = 30 seconds;
    uint64 public constant MAX_DURATION = 7 days;
    /// @notice How long the first player waits for the second before they can take their stake back.
    uint64 public constant JOIN_WINDOW = 15 minutes;
    /// @notice How long the referee has to settle after the duel ends before players can refund.
    uint64 public constant SETTLE_GRACE = 1 days;

    address public immutable referee;

    mapping(bytes32 => Duel) private _duels;
    /// @notice Payouts that could not be pushed (e.g. to a contract that rejects ETH), claimable later.
    mapping(address => uint256) public owed;

    event Entered(bytes32 indexed duelId, address indexed player, bytes32 commit);
    event Started(bytes32 indexed duelId, uint64 startedAt, uint64 endsAt);
    event Settled(
        bytes32 indexed duelId,
        address indexed winner,
        int32 scoreA,
        int32 scoreB,
        bytes32 cardA,
        bytes32 cardB,
        uint256 payout
    );
    event Refunded(bytes32 indexed duelId);

    error NotAPlayer();
    error SamePlayer();
    error BadDuration();
    error BadStake();
    error BadCommit();
    error AlreadyEntered();
    error WrongStatus(Status status);
    error TooEarly(uint64 notBefore);
    error BadReveal(address player);
    error BadSignature();
    error NothingOwed();

    constructor(address referee_) EIP712("PerpDuel", "1") {
        referee = referee_;
    }

    /// @notice The id of a duel is a hash of its terms, so nobody can squat an id with different terms.
    function duelIdOf(address playerA, address playerB, uint64 duration, uint256 stake, bytes32 nonce)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(playerA, playerB, duration, stake, nonce));
    }

    function getDuel(bytes32 duelId) external view returns (Duel memory) {
        return _duels[duelId];
    }

    /// @notice Stake and commit to a card. The duel starts when the second player enters.
    /// @param commit keccak256(abi.encode(duelId, msg.sender, cardHash, salt))
    function enter(address playerA, address playerB, uint64 duration, bytes32 nonce, bytes32 commit)
        external
        payable
        returns (bytes32 duelId)
    {
        if (msg.sender != playerA && msg.sender != playerB) revert NotAPlayer();
        if (playerA == playerB) revert SamePlayer();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        if (msg.value == 0 || msg.value > type(uint96).max) revert BadStake();
        if (commit == bytes32(0)) revert BadCommit();

        duelId = duelIdOf(playerA, playerB, duration, msg.value, nonce);
        Duel storage d = _duels[duelId];

        if (d.status == Status.None) {
            d.playerA = playerA;
            d.playerB = playerB;
            d.stake = uint96(msg.value);
            d.duration = duration;
            d.openedAt = uint64(block.timestamp);
            d.status = Status.Open;
        } else if (d.status != Status.Open) {
            revert WrongStatus(d.status);
        }

        if (msg.sender == playerA) {
            if (d.commitA != bytes32(0)) revert AlreadyEntered();
            d.commitA = commit;
        } else {
            if (d.commitB != bytes32(0)) revert AlreadyEntered();
            d.commitB = commit;
        }
        emit Entered(duelId, msg.sender, commit);

        if (d.commitA != bytes32(0) && d.commitB != bytes32(0)) {
            d.status = Status.Live;
            d.startedAt = uint64(block.timestamp);
            emit Started(duelId, d.startedAt, d.startedAt + d.duration);
        }
    }

    /// @notice Reveal both cards and pay out according to the referee's signed scores.
    /// Anyone may submit; the signature is what authorises the result.
    function settle(
        bytes32 duelId,
        Reveal calldata a,
        Reveal calldata b,
        int32 scoreA,
        int32 scoreB,
        bytes calldata signature
    ) external nonReentrant {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Live) revert WrongStatus(d.status);
        uint64 endsAt = d.startedAt + d.duration;
        if (block.timestamp < endsAt) revert TooEarly(endsAt);

        if (_commitOf(duelId, d.playerA, a) != d.commitA) revert BadReveal(d.playerA);
        if (_commitOf(duelId, d.playerB, b) != d.commitB) revert BadReveal(d.playerB);

        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, duelId, a.card, b.card, scoreA, scoreB)));
        if (ECDSA.recover(digest, signature) != referee) revert BadSignature();

        d.status = Status.Settled;
        uint256 pot = uint256(d.stake) * 2;

        if (scoreA == scoreB) {
            emit Settled(duelId, address(0), scoreA, scoreB, a.card, b.card, d.stake);
            _pay(d.playerA, d.stake);
            _pay(d.playerB, d.stake);
        } else {
            address winner = scoreA > scoreB ? d.playerA : d.playerB;
            emit Settled(duelId, winner, scoreA, scoreB, a.card, b.card, pot);
            _pay(winner, pot);
        }
    }

    /// @notice Escape hatch. Returns stakes if the opponent never showed up, or if the
    /// referee failed to settle within the grace period.
    function refund(bytes32 duelId) external nonReentrant {
        Duel storage d = _duels[duelId];
        if (d.status == Status.Open) {
            uint64 notBefore = d.openedAt + JOIN_WINDOW;
            if (block.timestamp < notBefore) revert TooEarly(notBefore);
            d.status = Status.Refunded;
            emit Refunded(duelId);
            _pay(d.commitA != bytes32(0) ? d.playerA : d.playerB, d.stake);
        } else if (d.status == Status.Live) {
            uint64 notBefore = d.startedAt + d.duration + SETTLE_GRACE;
            if (block.timestamp < notBefore) revert TooEarly(notBefore);
            d.status = Status.Refunded;
            emit Refunded(duelId);
            _pay(d.playerA, d.stake);
            _pay(d.playerB, d.stake);
        } else {
            revert WrongStatus(d.status);
        }
    }

    function claim() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "claim failed");
    }

    function _commitOf(bytes32 duelId, address player, Reveal calldata r) private pure returns (bytes32) {
        return keccak256(abi.encode(duelId, player, r.card, r.salt));
    }

    /// @dev Push the payment, but never let one player's failing receiver block the other's.
    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) owed[to] += amount;
    }
}
