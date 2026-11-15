// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DuelArena
/// @notice A 1v1 perp card duel with no referee. The contract deals, keeps score and pays out.
///
/// Each player stakes the same amount. A hand of five cards (market, side, leverage) is
/// dealt to each from a seed neither player controls. Each picks one card, a clock runs,
/// and the better synthetic return wins the pot. No positions are opened anywhere: the
/// contract reads Hyperliquid's own mark prices through a HyperEVM read precompile.
///
/// How each piece works without a trusted party:
///  - The deal.      seed = hash(saltA, saltB). A commits to saltA before seeing saltB, and
///                   B cannot see saltA, so neither can steer it. A sees the seed first and
///                   could walk away, which forfeits A's stake.
///  - The picks.     Commit, then reveal, so nobody picks after seeing the other's card.
///  - Hidden bonus.  Which of a player's cards carry a bonus is derived from a secret salt
///                   they committed to before the seed existed. Only they can work it out
///                   until they reveal it at the end.
///  - Prices.        Read from the precompile whenever anyone calls `poke`. Entry prices are
///                   read when the duel starts and exit prices by the first call at or
///                   after the end time.
///  - Liquidations.  The contract cannot watch prices between calls, so anyone may `poke`
///                   and the contract checks the price then. Your opponent has every reason
///                   to. A wick that nobody pokes during is not seen.
///  - Stalling.      Every step has a deadline. Whoever fails to act forfeits.
contract DuelArena is ReentrancyGuard {
    enum Phase {
        None,
        Open, // A has staked, waiting for an opponent
        Joined, // B has staked, waiting for A to reveal the deal salt
        Picking, // hands are dealt; commit a pick, then reveal it
        Live, // both cards revealed, clock running
        Closed, // exit prices recorded; players reveal their secret salt
        Settled,
        Cancelled
    }

    struct Seat {
        address player;
        bytes32 secretCommit;
        bytes32 pickCommit;
        uint8 pick;
        bool pickRevealed;
        bool secretRevealed;
        /// 0 for none, otherwise bonus id + 1. Known only after the secret is revealed.
        uint8 bonus;
        uint32 perp;
        bool isLong;
        uint16 leverage;
        uint64 entryPx;
        uint64 lastPx;
        /// Return on margin in basis points (100 = 1%). Frozen at -10000 once liquidated.
        int32 roe;
        int32 minRoe;
        int32 maxRoe;
        bool liquidated;
    }

    struct Duel {
        Phase phase;
        uint64 duration;
        uint96 stake;
        /// A's player nonce when the duel was opened, so A's client can re-derive its salts.
        uint64 nonceA;
        bytes32 dealCommit;
        bytes32 saltB;
        bytes32 seed;
        /// When the current step times out. Unused while Open or Live.
        uint64 deadline;
        uint64 startedAt;
        uint64 endAt;
        int32 scoreA;
        int32 scoreB;
        address winner;
        Seat[2] seats;
    }

    struct Card {
        /// Index into `markets`.
        uint8 market;
        bool isLong;
        uint16 leverage;
    }

    uint8 public constant HAND_SIZE = 5;
    uint8 public constant BONUS_COUNT = 8;
    uint64 public constant MIN_DURATION = 30 seconds;
    uint64 public constant MAX_DURATION = 1 days;
    /// @notice Time allowed for each step before the duel starts.
    uint64 public constant ACTION_WINDOW = 90 seconds;
    /// @notice Time allowed after the close to reveal a secret salt.
    uint64 public constant SECRET_WINDOW = 60 seconds;
    int32 private constant WIPED = -10_000;
    int256 private constant ROE_CAP = 1_000_000_000;

    /// @notice Where prices come from: HyperEVM's mark price precompile (0x…0806).
    /// Called with abi.encode(uint32 perpIndex), returns a uint64 raw price.
    address public immutable priceFeed;
    /// @notice Hyperliquid perp indices the deck is dealt from.
    uint32[] public markets;

    uint256 public duelCount;
    mapping(uint256 => Duel) private _duels;
    /// @notice The open duel waiting for an opponent at given terms, keyed by hash(duration, stake).
    mapping(bytes32 => uint256) public waiting;
    /// @notice The unfinished duel a player is seated in, if any.
    mapping(address => uint256) public activeOf;
    /// @notice How many duels a player has opened. Lets a client derive fresh salts from its key.
    mapping(address => uint64) public opened;
    /// @notice Payouts that could not be pushed, claimable later.
    mapping(address => uint256) public owed;

    event Opened(uint256 indexed id, address indexed playerA, uint64 duration, uint256 stake);
    event Joined(uint256 indexed id, address indexed playerB);
    event Dealt(uint256 indexed id, bytes32 seed);
    event PickCommitted(uint256 indexed id, uint8 seat);
    event Started(uint256 indexed id, uint64 startedAt, uint64 endAt);
    event Liquidated(uint256 indexed id, uint8 seat, uint64 price);
    event Closed(uint256 indexed id);
    event SecretRevealed(uint256 indexed id, uint8 seat, uint8 bonus);
    event Settled(uint256 indexed id, address indexed winner, int32 scoreA, int32 scoreB, uint256 payout);
    event Cancelled(uint256 indexed id);
    event Forfeited(uint256 indexed id, address indexed winner);

    error BadTerms();
    error BadValue();
    error Busy();
    error Taken();
    error NotSeated();
    error WrongPhase(Phase phase);
    error BadReveal();
    error AlreadyDone();
    error TooEarly(uint64 notBefore);
    error TooLate();
    error PriceUnavailable(uint32 perp);
    error NothingOwed();

    constructor(address priceFeed_, uint32[] memory markets_) {
        if (markets_.length < HAND_SIZE || markets_.length > 64) revert BadTerms();
        priceFeed = priceFeed_;
        markets = markets_;
        // Fail the deployment, not a duel, if any market has no price.
        for (uint256 i = 0; i < markets_.length; i++) {
            _px(markets_[i]);
        }
    }

    // ------------------------------------------------------------------ views

    function getDuel(uint256 id) external view returns (Duel memory) {
        return _duels[id];
    }

    function marketList() external view returns (uint32[] memory) {
        return markets;
    }

    function termsKey(uint64 duration, uint256 stake) public pure returns (bytes32) {
        return keccak256(abi.encode(duration, stake));
    }

    function seedOf(uint256 id, bytes32 saltA, bytes32 saltB) public pure returns (bytes32) {
        return keccak256(abi.encode(id, saltA, saltB));
    }

    /// @notice The five cards dealt to a seat. Distinct markets, drawn by a partial shuffle.
    function handOf(bytes32 seed, uint8 seat) public view returns (Card[5] memory hand) {
        uint256 n = markets.length;
        uint8[] memory order = new uint8[](n);
        for (uint256 i = 0; i < n; i++) {
            order[i] = uint8(i);
        }
        uint16[4] memory tiers = [uint16(100), 250, 500, 1000];
        for (uint256 i = 0; i < HAND_SIZE; i++) {
            uint256 h = uint256(keccak256(abi.encode(seed, seat, i)));
            uint256 j = i + (h % (n - i));
            (order[i], order[j]) = (order[j], order[i]);
            hand[i] = Card({market: order[i], isLong: (h >> 128) & 1 == 1, leverage: tiers[(h >> 160) % 4]});
        }
    }

    /// @notice The bonus a card carries, as id + 1, or 0. Two cards in every hand carry one.
    function bonusOf(bytes32 secretSalt, bytes32 seed, uint8 cardIndex) public pure returns (uint8) {
        uint256 b = uint256(keccak256(abi.encode(secretSalt, seed)));
        uint256 slot1 = b % HAND_SIZE;
        uint256 slot2 = (slot1 + 1 + ((b >> 8) % (HAND_SIZE - 1))) % HAND_SIZE;
        uint256 id1 = (b >> 16) % BONUS_COUNT;
        uint256 id2 = (id1 + 1 + ((b >> 24) % (BONUS_COUNT - 1))) % BONUS_COUNT;
        if (cardIndex == slot1) return uint8(id1 + 1);
        if (cardIndex == slot2) return uint8(id2 + 1);
        return 0;
    }

    /// @notice Both positions as they would stand if poked right now.
    function live(uint256 id) external view returns (Seat memory a, Seat memory b, uint64 nowTs) {
        Duel storage d = _duels[id];
        a = d.seats[0];
        b = d.seats[1];
        if (d.phase == Phase.Live) {
            _mark(a);
            _mark(b);
        }
        nowTs = uint64(block.timestamp);
    }

    // --------------------------------------------------------- before the duel

    /// @notice Open a duel and wait for an opponent.
    /// @param dealCommit   keccak256(abi.encode(msg.sender, dealSalt))
    /// @param secretCommit keccak256(abi.encode(msg.sender, secretSalt))
    function open(uint64 duration, bytes32 dealCommit, bytes32 secretCommit) external payable returns (uint256 id) {
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadTerms();
        if (msg.value == 0 || msg.value > type(uint96).max) revert BadValue();
        if (activeOf[msg.sender] != 0) revert Busy();
        bytes32 key = termsKey(duration, msg.value);
        if (waiting[key] != 0) revert Taken();

        id = ++duelCount;
        Duel storage d = _duels[id];
        d.phase = Phase.Open;
        d.duration = duration;
        d.stake = uint96(msg.value);
        d.nonceA = opened[msg.sender]++;
        d.dealCommit = dealCommit;
        d.seats[0].player = msg.sender;
        d.seats[0].secretCommit = secretCommit;
        waiting[key] = id;
        activeOf[msg.sender] = id;
        emit Opened(id, msg.sender, duration, msg.value);
    }

    /// @notice Take your stake back while nobody has joined.
    function cancel(uint256 id) external nonReentrant {
        Duel storage d = _duels[id];
        if (d.phase != Phase.Open) revert WrongPhase(d.phase);
        if (d.seats[0].player != msg.sender) revert NotSeated();
        d.phase = Phase.Cancelled;
        delete waiting[termsKey(d.duration, d.stake)];
        delete activeOf[msg.sender];
        emit Cancelled(id);
        _pay(msg.sender, d.stake);
    }

    /// @notice Join an open duel. `saltB` is public: A is already committed, so it cannot be used against you.
    function join(uint256 id, bytes32 saltB, bytes32 secretCommit) external payable {
        Duel storage d = _duels[id];
        if (d.phase != Phase.Open) revert WrongPhase(d.phase);
        if (msg.value != d.stake) revert BadValue();
        if (activeOf[msg.sender] != 0) revert Busy();
        d.phase = Phase.Joined;
        d.saltB = saltB;
        d.seats[1].player = msg.sender;
        d.seats[1].secretCommit = secretCommit;
        d.deadline = uint64(block.timestamp) + ACTION_WINDOW;
        delete waiting[termsKey(d.duration, d.stake)];
        activeOf[msg.sender] = id;
        emit Joined(id, msg.sender);
    }

    /// @notice A reveals the deal salt, which fixes the seed and both hands.
    function deal(uint256 id, bytes32 dealSalt) external {
        Duel storage d = _duels[id];
        if (d.phase != Phase.Joined) revert WrongPhase(d.phase);
        if (keccak256(abi.encode(d.seats[0].player, dealSalt)) != d.dealCommit) revert BadReveal();
        d.seed = seedOf(id, dealSalt, d.saltB);
        d.phase = Phase.Picking;
        d.deadline = uint64(block.timestamp) + ACTION_WINDOW;
        emit Dealt(id, d.seed);
    }

    /// @param commit keccak256(abi.encode(id, msg.sender, cardIndex, pickSalt))
    function commitPick(uint256 id, bytes32 commit) external {
        Duel storage d = _duels[id];
        if (d.phase != Phase.Picking) revert WrongPhase(d.phase);
        if (block.timestamp > d.deadline) revert TooLate();
        uint8 s = _seatOf(d, msg.sender);
        if (d.seats[s].pickCommit != bytes32(0) || commit == bytes32(0)) revert AlreadyDone();
        d.seats[s].pickCommit = commit;
        emit PickCommitted(id, s);
        if (d.seats[1 - s].pickCommit != bytes32(0)) {
            d.deadline = uint64(block.timestamp) + ACTION_WINDOW;
        }
    }

    /// @notice Show your card. The duel starts when both are shown.
    function revealPick(uint256 id, uint8 cardIndex, bytes32 pickSalt) external {
        Duel storage d = _duels[id];
        if (d.phase != Phase.Picking) revert WrongPhase(d.phase);
        if (block.timestamp > d.deadline) revert TooLate();
        uint8 s = _seatOf(d, msg.sender);
        Seat storage seat = d.seats[s];
        if (d.seats[0].pickCommit == bytes32(0) || d.seats[1].pickCommit == bytes32(0)) revert WrongPhase(d.phase);
        if (seat.pickRevealed) revert AlreadyDone();
        if (cardIndex >= HAND_SIZE) revert BadReveal();
        if (keccak256(abi.encode(id, msg.sender, cardIndex, pickSalt)) != seat.pickCommit) revert BadReveal();

        Card memory card = handOf(d.seed, s)[cardIndex];
        seat.pick = cardIndex;
        seat.pickRevealed = true;
        seat.perp = markets[card.market];
        seat.isLong = card.isLong;
        seat.leverage = card.leverage;

        if (d.seats[1 - s].pickRevealed) {
            for (uint8 i = 0; i < 2; i++) {
                uint64 px = _px(d.seats[i].perp);
                d.seats[i].entryPx = px;
                d.seats[i].lastPx = px;
            }
            d.phase = Phase.Live;
            d.startedAt = uint64(block.timestamp);
            d.endAt = d.startedAt + d.duration;
            emit Started(id, d.startedAt, d.endAt);
        }
    }

    // --------------------------------------------------------- during and after

    /// @notice Read current prices into the duel. Anyone may call, as often as they like.
    /// During the duel this records highs, lows and liquidations. The first call at or after
    /// the end time records the exit prices and closes the duel.
    function poke(uint256 id) public {
        Duel storage d = _duels[id];
        if (d.phase != Phase.Live) revert WrongPhase(d.phase);
        for (uint8 i = 0; i < 2; i++) {
            Seat memory seat = d.seats[i];
            bool was = seat.liquidated;
            _mark(seat);
            d.seats[i] = seat;
            if (seat.liquidated && !was) emit Liquidated(id, i, seat.lastPx);
        }
        if (block.timestamp >= d.endAt) {
            d.phase = Phase.Closed;
            d.deadline = uint64(block.timestamp) + SECRET_WINDOW;
            emit Closed(id);
        }
    }

    /// @notice Reveal your secret salt so your card's hidden bonus can be scored.
    /// Closes the duel first if nobody has yet. Pays out once both players have revealed.
    function reveal(uint256 id, bytes32 secretSalt) external nonReentrant {
        Duel storage d = _duels[id];
        if (d.phase == Phase.Live) {
            if (block.timestamp < d.endAt) revert TooEarly(d.endAt);
            poke(id);
        }
        if (d.phase != Phase.Closed) revert WrongPhase(d.phase);
        uint8 s = _seatOf(d, msg.sender);
        Seat storage seat = d.seats[s];
        if (seat.secretRevealed) revert AlreadyDone();
        if (keccak256(abi.encode(msg.sender, secretSalt)) != seat.secretCommit) revert BadReveal();
        seat.secretRevealed = true;
        seat.bonus = bonusOf(secretSalt, d.seed, seat.pick);
        emit SecretRevealed(id, s, seat.bonus);
        if (d.seats[1 - s].secretRevealed) _settle(id, d);
    }

    /// @notice Pay out once the reveal window has passed. A player who never revealed scores no bonus.
    function settle(uint256 id) external nonReentrant {
        Duel storage d = _duels[id];
        if (d.phase == Phase.Live && block.timestamp >= d.endAt) poke(id);
        if (d.phase != Phase.Closed) revert WrongPhase(d.phase);
        if (block.timestamp <= d.deadline) revert TooEarly(d.deadline + 1);
        _settle(id, d);
    }

    /// @notice Resolve a duel where someone missed a deadline before the start.
    /// Whoever got further takes the pot. If both stalled at the same point, stakes go back.
    function timeout(uint256 id) external nonReentrant {
        Duel storage d = _duels[id];
        if (d.phase != Phase.Joined && d.phase != Phase.Picking) revert WrongPhase(d.phase);
        if (block.timestamp <= d.deadline) revert TooEarly(d.deadline + 1);
        Seat storage a = d.seats[0];
        Seat storage b = d.seats[1];

        uint8 doneA;
        uint8 doneB;
        if (d.phase == Phase.Joined) {
            doneB = 1; // only A had something to do
        } else {
            doneA = (a.pickCommit != bytes32(0) ? 1 : 0) + (a.pickRevealed ? 1 : 0);
            doneB = (b.pickCommit != bytes32(0) ? 1 : 0) + (b.pickRevealed ? 1 : 0);
        }
        d.phase = Phase.Cancelled;
        delete activeOf[a.player];
        delete activeOf[b.player];
        if (doneA == doneB) {
            emit Cancelled(id);
            _pay(a.player, d.stake);
            _pay(b.player, d.stake);
        } else {
            address winner = doneA > doneB ? a.player : b.player;
            d.winner = winner;
            emit Forfeited(id, winner);
            _pay(winner, uint256(d.stake) * 2);
        }
    }

    function claim() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "claim failed");
    }

    // ---------------------------------------------------------------- scoring

    /// @notice Points for a bonus, by id: phoenix, close shave, comeback, moonshot,
    /// schadenfreude, flatline, underdog, whipsaw.
    function bonusPoints(uint8 bonusId, Seat memory me, Seat memory opp) public pure returns (int32) {
        if (bonusId == 0) return me.liquidated ? int32(250) : int32(0);
        if (bonusId == 1) return !me.liquidated && me.minRoe <= -7_500 ? int32(100) : int32(0);
        if (bonusId == 2) return !me.liquidated && me.minRoe <= -5_000 && me.roe > 0 ? int32(80) : int32(0);
        if (bonusId == 3) return me.maxRoe >= 10_000 ? int32(60) : int32(0);
        if (bonusId == 4) return opp.liquidated ? int32(100) : int32(0);
        if (bonusId == 5) return !me.liquidated && me.roe >= -1_000 && me.roe <= 1_000 ? int32(75) : int32(0);
        if (bonusId == 6) return me.leverage < opp.leverage && me.roe > opp.roe ? int32(75) : int32(0);
        if (bonusId == 7) return me.maxRoe >= 5_000 && me.minRoe <= -5_000 ? int32(80) : int32(0);
        return 0;
    }

    /// @notice A seat's score in tenths of a point: one point per 1% return, plus any bonus.
    function scoreOf(Seat memory me, Seat memory opp) public pure returns (int32) {
        int32 bonus = me.bonus == 0 ? int32(0) : bonusPoints(me.bonus - 1, me, opp);
        return me.roe / 10 + bonus * 10;
    }

    function _settle(uint256 id, Duel storage d) private {
        Seat memory a = d.seats[0];
        Seat memory b = d.seats[1];
        d.scoreA = scoreOf(a, b);
        d.scoreB = scoreOf(b, a);
        d.phase = Phase.Settled;
        delete activeOf[a.player];
        delete activeOf[b.player];
        if (d.scoreA == d.scoreB) {
            emit Settled(id, address(0), d.scoreA, d.scoreB, d.stake);
            _pay(a.player, d.stake);
            _pay(b.player, d.stake);
        } else {
            d.winner = d.scoreA > d.scoreB ? a.player : b.player;
            uint256 pot = uint256(d.stake) * 2;
            emit Settled(id, d.winner, d.scoreA, d.scoreB, pot);
            _pay(d.winner, pot);
        }
    }

    /// @dev Bring a seat up to the current price. Once liquidated, a seat never changes.
    function _mark(Seat memory seat) private view {
        if (seat.liquidated) return;
        uint64 px = _px(seat.perp);
        int256 move = int256(uint256(px)) - int256(uint256(seat.entryPx));
        if (!seat.isLong) move = -move;
        int256 roe = (move * int256(uint256(seat.leverage)) * 10_000) / int256(uint256(seat.entryPx));
        if (roe > ROE_CAP) roe = ROE_CAP;
        seat.lastPx = px;
        if (roe <= WIPED) {
            seat.liquidated = true;
            seat.roe = WIPED;
            seat.minRoe = WIPED;
            return;
        }
        seat.roe = int32(roe);
        if (seat.roe < seat.minRoe) seat.minRoe = seat.roe;
        if (seat.roe > seat.maxRoe) seat.maxRoe = seat.roe;
    }

    /// @dev Gas is capped because the precompile burns everything it is given on a bad index.
    function _px(uint32 perp) private view returns (uint64 px) {
        (bool ok, bytes memory out) = priceFeed.staticcall{gas: 100_000}(abi.encode(perp));
        if (!ok || out.length < 32) revert PriceUnavailable(perp);
        px = abi.decode(out, (uint64));
        if (px == 0) revert PriceUnavailable(perp);
    }

    function _seatOf(Duel storage d, address who) private view returns (uint8) {
        if (d.seats[0].player == who) return 0;
        if (d.seats[1].player == who) return 1;
        revert NotSeated();
    }

    /// @dev Push the payment, but never let one player's failing receiver block the other's.
    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) owed[to] += amount;
    }
}
