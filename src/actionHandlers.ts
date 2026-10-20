import type Client from "./Client.js";
import GameModes from "./GameMode.js";
import { InsaneInt } from "./InsaneInt.js";
import Lobby, { MAX_PLAYERS, getEnemy } from "./Lobby.js";
import type {
	ActionCreateLobby,
	ActionEatPizza,
	ActionHandlerArgs,
	ActionHandlers,
	ActionJoinLobby,
	ActionRejoinLobby,
	ActionMagnet,
	ActionMagnetResponse,
	ActionPlayHand,
	ActionReceiveEndGameJokersRequest,
	ActionReceiveNemesisDeckRequest,
	ActionReceiveNemesisStatsRequest,
	ActionRemovePhantom,
	ActionSendPhantom,
	ActionSetAnte,
	ActionSetLocation,
	ActionSetFurthestBlind,
	ActionSkip,
	ActionSpentLastShop,
	ActionStartAnteTimer,
	ActionPauseAnteTimerRequest,
	ActionSyncClient,
	ActionSubmitLogHashes,
	ActionStreamLogLines,
	ActionUsername,
	ActionVersion,
	ActionTcgServerVersion,
	ActionTcgBet,
	ActionTcgPlayerStatusRequest,
	ActionTcgEndTurn,
	ActionModded,
	ActionModdedRequest,
	ActionHandyMPExtensionEnable,
	ActionHandyMPExtensionDisable,
    ActionDataSyncRequest,
	ActionServerToClient,
} from "./actions.js";
import { generateSeed } from "./utils.js";
import {
	deleteLiveLog,
	recordLiveLogLines,
	recordLogHashes,
} from "./logHashStore.js";

/** Current TCG server version - clients must match this to use TCG features */
const TCG_SERVER_VERSION = 1;

const usernameAction = (
	{ username, modHash, maxPlayers }: ActionHandlerArgs<ActionUsername>,
	client: Client,
) => {
	const supported = Math.floor(Number(maxPlayers));
	if (supported >= 2) client.maxPlayers = Math.min(supported, MAX_PLAYERS);
	client.setUsername(username);
	client.setModHash(modHash);
};

const createLobbyAction = (
	{ gameMode }: ActionHandlerArgs<ActionCreateLobby>,
	client: Client,
) => {
	/** Also sets the client lobby to this newly created one */
	new Lobby(client, gameMode);
};

const joinLobbyAction = (
	{ code }: ActionHandlerArgs<ActionJoinLobby>,
	client: Client,
) => {
	const newLobby = Lobby.get(code);
	if (!newLobby) {
		client.sendAction({
			action: "error",
			message: "Lobby does not exist.",
		});
		return;
	}
	newLobby.join(client);
};

const leaveLobbyAction = (client: Client) => {
	client.lobby?.leave(client);
};

/** Called when a client's TCP connection drops (not voluntary) */
const disconnectFromLobbyAction = (client: Client) => {
	client.lobby?.disconnect(client);
};

const rejoinLobbyAction = (
	{ code, reconnectToken }: ActionHandlerArgs<ActionRejoinLobby>,
	client: Client,
) => {
	const lobby = Lobby.get(code);
	if (!lobby) {
		client.sendAction({
			action: "error",
			message: "Lobby no longer exists.",
		});
		return;
	}

	if (!lobby.rejoin(client, reconnectToken)) {
		client.sendAction({
			action: "error",
			message: "Could not rejoin lobby. Token invalid or slot expired.",
		});
	}
};

const lobbyInfoAction = (client: Client) => {
	client.lobby?.broadcastLobbyInfo();
};

const readyLobbyAction = (client: Client) => {
	client.isReadyLobby = true;
	client.lobby?.broadcastLobbyInfo();
};

const unreadyLobbyAction = (client: Client) => {
	client.isReadyLobby = false;
	client.lobby?.broadcastLobbyInfo();
};

const keepAliveAction = (client: Client) => {
	// Send an ack back to the received keepAlive
	client.sendAction({ action: "keepAliveAck" });
};

const startGameAction = (client: Client) => {
	const lobby = client.lobby;

	// Only allow the host to start the game
	if (!lobby || lobby.host?.id !== client.id) {
		return;
	}
	if (lobby.players.length < 2 || (lobby.isInGame && !lobby.matchOver)) {
		return;
	}

	// Only start the game if guest is ready
	// TODO: Uncomment this when Client ready is released in the mod
	// if (!lobby.guest?.isReadyLobby) {
	// 	return;
	// }

	const lives = lobby.options.starting_lives
		? Number.parseInt(lobby.options.starting_lives)
		: GameModes[lobby.gameMode].startingLives;

	// Remember the authoritative seed so end-of-game log hashes can be keyed by
	// it (null for different-seeds games, where each client uses its own).
	const seed = lobby.options.different_seeds ? undefined : generateSeed();
	lobby.seed = seed ?? null;
	// resetPlayers() clears isInGame, so it must run before we set it true below.
	lobby.resetPlayers();

	lobby.isInGame = true;
	lobby.multi = lobby.players.length > 2;
	lobby.broadcastAction({
		action: "startGame",
		deck: "c_multiplayer_1",
		seed,
		...(lobby.multi ? { playerCount: lobby.players.length } : {}),
	});

	// Reset players' lives
	lobby.setPlayersLives(lives);

	// Unready guests for next game
	for (const player of lobby.players) {
		if (player !== lobby.host) player.isReadyLobby = false;
	}
	lobby.broadcastPlayersInfo();
};

const readyBlindAction = (client: Client) => {
	if (client.eliminated) return;
	client.isReady = true;
	client.readyAt = Date.now();

	const lobby = client.lobby;
	if (lobby) lobby.clearTimers(client);
	else client.timeredBy.clear();
	const opponents = lobby?.getOpponents(client) ?? [];

	// Readying while the others still play a PvP blind (after losing it on the
	// timer) is settled when that blind ends
	if (
		!lobby?.pvpActive &&
		!client.firstReady &&
		!opponents.some((p) => p.isReady || p.firstReady)
	) {
		client.firstReady = true;
		if (lobby) lobby.firstReadyAt = Date.now();
		client.sendAction({ action: "speedrun" });
	}

	lobby?.checkAllReady(client);
	lobby?.broadcastPlayersInfo();
};

const unreadyBlindAction = (client: Client) => {
	client.isReady = false;
};

const playHandAction = (
	{ handsLeft, score }: ActionHandlerArgs<ActionPlayHand>,
	client: Client,
) => {
	const lobby = client.lobby;

	if (lobby === null || lobby.players.length < 2) {
		stopGameAction(client);
		return;
	}
	if (client.eliminated || lobby.matchOver) return;
	// Lost this PvP blind on the timer: the score stays frozen until it ends
	if (lobby.pvpActive && client.pvpResolved) return;

	client.score = InsaneInt.fromString(String(score));

	client.handsLeft =
		typeof handsLeft === "number" ? handsLeft : Number(handsLeft);
	client.handsLeft = Math.floor(client.handsLeft);

	// A bootstrap play emitted at blind start reports score 0 (no hand actually
	// committed). A real hand always scores > 0, so use that to decide whether the
	// player has genuinely played this blind. Hand counts can vary in this game, so
	// handsLeft is not a reliable signal.
	const playedRealHand = client.score.greaterThan(new InsaneInt(0, 0, 0));
	if (playedRealHand) client.playedThisBlind = true;

	// Reveal our score to the opponents immediately, unless the lobby option
	// hide_score_until_played (default OFF; only standard-layer rulesets send
	// it) withholds it until they have also committed a hand this blind. On our
	// first real hand we also get their scores that were withheld from us.
	for (const opponent of lobby.getOpponents(client)) lobby.sendPvPEnemyInfo(opponent);
	lobby.sendPvPEnemyInfo(client);
	lobby.broadcastPlayersInfo();

	lobby.pruneTimers();
	lobby.checkPvPRound();
};

const failPvPTimerAction = (
	client: Client,
) => {
	const lobby = client.lobby;
	if (client.eliminated) return;

	client.loseLife('timer');

	if (!lobby) return;

	lobby.failPvPTimer(client);
}

const stopGameAction = (client: Client) => {
	const lobby = client.lobby;
	if (!lobby) {
		return;
	}
	// Leaving a game the others can finish only takes this player out of it
	if (lobby.playsOnWithout()) {
		lobby.eliminate(client, false);
		client.sendAction({ action: "stopGame" });
		return;
	}
	lobby.broadcastAction({ action: "stopGame" });
	lobby.dropDisconnected();
	lobby.resetPlayers();
};

// Deprecated
const gameInfoAction = (client: Client) => {
	client.lobby?.sendGameInfo(client);
};

const lobbyOptionsAction = (
	options: Record<string, string>,
	client: Client,
) => {
	client.lobby?.setOptions(options);
};

const failRoundAction = (client: Client) => {
	const lobby = client.lobby;
	if (!lobby || lobby.getOpponents(client).length === 0) return;
	if (client.eliminated) return;

	if (lobby.options.death_on_round_loss) {
		client.loseLife('round');
	}

	if (client.lives <= 0) {
		if (lobby.gameMode === "survival") {
			lobby.checkSurvival();
		} else {
			lobby.eliminate(client);
		}
	}
};

const setAnteAction = (
	{ ante }: ActionHandlerArgs<ActionSetAnte>,
	client: Client,
) => {
	client.ante = ante;
};

// TODO: Fix this
const serverVersion = "0.3.2-MULTIPLAYER";
/** Verifies the client version and allows connection if it matches the server's */
const versionAction = (
	{ version }: ActionHandlerArgs<ActionVersion>,
	client: Client,
) => {
	const versionMatch = version.match(/^(\d+\.\d+\.\d+)/);
	if (versionMatch) {
		const clientVersion = versionMatch[1];
		const serverVersionNumber = serverVersion.split("-")[0];

		const [clientMajor, clientMinor, clientPatch] = clientVersion
			.split(".")
			.map(Number);
		const [serverMajor, serverMinor, serverPatch] = serverVersionNumber
			.split(".")
			.map(Number);

		if (
			clientMajor < serverMajor ||
			(clientMajor === serverMajor && clientMinor < serverMinor) ||
			(clientMajor === serverMajor &&
				clientMinor === serverMinor &&
				clientPatch < serverPatch)
		) {
			client.sendAction({
				action: "error",
				message: `[WARN] Server expecting version ${serverVersion}`,
			});
		}
	}
};

const setLocationAction = (
	{ location }: ActionHandlerArgs<ActionSetLocation>,
	client: Client,
) => {
	client.setLocation(location);
};

const newRoundAction = (client: Client) => {
	client.resetBlocker();
};

const setFurthestBlindAction = (
	{ furthestBlind }: ActionHandlerArgs<ActionSetFurthestBlind>,
	client: Client,
) => {
	const lobby = client.lobby;
	client.furthestBlind = furthestBlind;
	if (!lobby || lobby.players.length < 2) return;

	// A dead player loses once someone gets further
	if (lobby.gameMode === "survival") lobby.checkSurvival();
};

const skipAction = (
	{ skips }: ActionHandlerArgs<ActionSkip>,
	client: Client,
) => {
	const lobby = client.lobby;
	if (client.eliminated) return;
	if (lobby?.multi) {
		for (let i = client.skips; i < skips; i++) client.shopSpends.push(0);
	}
	client.setSkips(skips);
	if (!lobby || lobby.getOpponents(client).length === 0) return;
	lobby.sendEnemyInfo(client);
	lobby.sendShopSpends();
	lobby.broadcastPlayersInfo();
};

const sendPhantomAction = (
	{ key }: ActionHandlerArgs<ActionSendPhantom>,
	client: Client,
) => {
	const lobby = client.lobby;
	if (!lobby || client.eliminated) return;
	client.phantoms.set(key, (client.phantoms.get(key) ?? 0) + 1);
	lobby.relayToOpponents(client, {
		action: "sendPhantom",
		key,
	});
};

const removePhantomAction = (
	{ key }: ActionHandlerArgs<ActionRemovePhantom>,
	client: Client,
) => {
	const lobby = client.lobby;
	if (!lobby || client.eliminated) return;
	const count = client.phantoms.get(key) ?? 0;
	if (count > 1) client.phantoms.set(key, count - 1);
	else client.phantoms.delete(key);
	lobby.relayToOpponents(client, {
		action: "removePhantom",
		key,
	});
};

const asteroidAction = (client: Client) => {
	if (client.eliminated) return;
	client.lobby?.relayToOpponents(client, {
		action: "asteroid",
	});
};

const letsGoGamblingNemesisAction = (client: Client) => {
	if (client.eliminated) return;
	client.lobby?.relayToOpponents(client, {
		action: "letsGoGamblingNemesis",
	});
};

const eatPizzaAction = (
	{ whole }: ActionHandlerArgs<ActionEatPizza>,
	client: Client,
) => {
	if (client.eliminated) return;
	client.lobby?.relayToOpponents(client, {
		action: "eatPizza",
		whole,
	});
};

/** Taxes counts what the opponent sold; with several, their average */
const soldJokerAction = (client: Client) => {
	const lobby = client.lobby;
	if (!lobby || client.eliminated) return;
	if (!lobby.multi) {
		lobby.relayToOpponents(client, {
			action: "soldJoker",
		});
		return;
	}
	client.sells++;
	lobby.sendSells();
};

/** Penny Pincher reads the opponent's shop spends; with several, their average */
const spentLastShopAction = (
	{ amount }: ActionHandlerArgs<ActionSpentLastShop>,
	client: Client,
) => {
	const lobby = client.lobby;
	if (!lobby || client.eliminated) return;
	if (!lobby.multi) {
		lobby.relayToOpponents(client, {
			action: "spentLastShop",
			amount,
		});
		return;
	}
	client.shopSpends.push(Number(amount) || 0);
	lobby.sendShopSpends();
};

/** Magnet copies a joker from one opponent, picked at random when there are several */
const magnetAction = (client: Client) => {
	const lobby = client.lobby;
	if (!lobby || client.eliminated) return;
	const opponents = lobby.getOpponents(client);
	if (opponents.length === 0) return;
	const target = opponents[Math.floor(Math.random() * opponents.length)];
	lobby.requestFrom(target, client, "magnet", {
		action: "magnet",
	});
};

const magnetResponseAction = (
	{ key }: ActionHandlerArgs<ActionMagnetResponse>,
	client: Client,
) => {
	client.lobby?.answerRequest(client, "magnet", {
		action: "magnetResponse",
		key,
	});
};

const getEndGameJokersAction = (client: Client) => {
	const lobby = client.lobby;
	lobby?.requestFrom(lobby.endGameTarget(client), client, "jokers", {
		action: "getEndGameJokers",
	});
};

const receiveEndGameJokersAction = (
	{ keys }: ActionHandlerArgs<ActionReceiveEndGameJokersRequest>,
	client: Client,
) => {
	client.lobby?.answerRequest(client, "jokers", {
		action: "receiveEndGameJokers",
		keys,
	});
};

const getNemesisDeckAction = (client: Client) => {
	const lobby = client.lobby;
	lobby?.requestFrom(lobby.endGameTarget(client), client, "deck", {
		action: "getNemesisDeck",
	});
};

const receiveNemesisDeckAction = (
	{ cards }: ActionHandlerArgs<ActionReceiveNemesisDeckRequest>,
	client: Client,
) => {
	client.lobby?.answerRequest(client, "deck", {
		action: "receiveNemesisDeck",
		cards,
	});
};

const requestNemesisStatsActionHandler = (client: Client) => {
	const lobby = client.lobby;
	lobby?.requestFrom(lobby.endGameTarget(client), client, "stats", {
		action: "endGameStatsRequested",
	});
};

const receiveNemesisStatsActionHandler = (
	stats: ActionHandlerArgs<ActionReceiveNemesisStatsRequest>,
	client: Client,
) => {
	client.lobby?.answerRequest(client, "stats", {
		action: "nemesisEndGameStats",
		...stats,
	});
};

const startAnteTimerAction = (
	{ time, isPvP }: ActionHandlerArgs<ActionStartAnteTimer>,
	client: Client,
) => {
	const lobby = client.lobby;
	if (!lobby || client.eliminated) return;
	const action: ActionServerToClient = {
		action: "startAnteTimer",
		time,
		...(isPvP ? { isPvP: true } : {}),
	};
	if (lobby.multi) {
		lobby.startTimer(client, action, Boolean(isPvP));
	} else {
		lobby.relayToOpponents(client, action);
	}
};

const pauseAnteTimerAction = (
	{ time }: ActionHandlerArgs<ActionPauseAnteTimerRequest>,
	client: Client,
) => {
	const lobby = client.lobby;
	if (!lobby || client.eliminated) return;
	if (lobby.multi) {
		lobby.pauseTimer(client, time);
	} else {
		lobby.relayToOpponents(client, {
			action: "pauseAnteTimer",
			time,
		});
	}
};

const failTimerAction = (client: Client) => {
	const lobby = client.lobby;
	if (client.eliminated) return;

	client.loseLife('timer');

	if (!lobby) return;
	lobby.clearTimers(client);

	if (client.lives <= 0) {
		lobby.eliminate(client);
	}
};

const syncClientAction = (
	{ isCached }: ActionHandlerArgs<ActionSyncClient>,
	client: Client,
) => {
	client.isCached = isCached;
};

// TCG Action Handlers
const tcgServerVersionAction = (
	{ version }: ActionHandlerArgs<ActionTcgServerVersion>,
	client: Client,
) => {
	// Only send tcg_compatible if the client's version is compatible (>= server version)
	if (version >= TCG_SERVER_VERSION) {
		client.sendAction({ action: "tcg_compatible" });
	}
};

const startTcgBettingAction = (client: Client) => {
	const lobby = client.lobby;

	// Only allow the host to start the TCG game
	if (!lobby || lobby.host?.id !== client.id) {
		return;
	}

	// Clear any existing bets
	lobby.tcgBets.clear();

	// Broadcast startGame with seed to both players
	lobby.broadcastAction({
		action: "startGame",
		deck: "c_multiplayer_1",
		seed: generateSeed(),
	});
};

const tcgBetAction = (
	{ bet }: ActionHandlerArgs<ActionTcgBet>,
	client: Client,
) => {
	const [lobby, enemy] = getEnemy(client);
	if (!lobby || !enemy) return;

	// Store this client's bet
	lobby.tcgBets.set(client.id, bet);

	// Check if both players have bet
	if (!lobby.host || !lobby.guest) return;
	if (!lobby.tcgBets.has(lobby.host.id) || !lobby.tcgBets.has(lobby.guest.id)) {
		return;
	}

	// Both players have bet, determine winner
	const hostBet = lobby.tcgBets.get(lobby.host.id) ?? 0;
	const guestBet = lobby.tcgBets.get(lobby.guest.id) ?? 0;

	let winner: Client;
	let loser: Client;

	if (hostBet > guestBet) {
		winner = lobby.host;
		loser = lobby.guest;
	} else if (guestBet > hostBet) {
		winner = lobby.guest;
		loser = lobby.host;
	} else {
		// Equal bets - flip a coin
		if (Math.random() < 0.5) {
			winner = lobby.host;
			loser = lobby.guest;
		} else {
			winner = lobby.guest;
			loser = lobby.host;
		}
	}

	const winnerBet = lobby.tcgBets.get(winner.id) ?? 0;

	// Winner receives their bet as damage and starts first
	winner.sendAction({
		action: "tcgStartGame",
		damage: winnerBet,
		starting: true,
	});

	// Loser receives 0 damage and doesn't start
	loser.sendAction({
		action: "tcgStartGame",
		damage: 0,
		starting: false,
	});

	// Clear bets for next round
	lobby.tcgBets.clear();
};

const tcgPlayerStatusAction = (
	args: ActionHandlerArgs<ActionTcgPlayerStatusRequest>,
	client: Client,
) => {
	const [lobby, enemy] = getEnemy(client);
	if (!lobby || !enemy) return;

	// Echo the action to the other player
	enemy.sendAction({
		action: "tcgPlayerStatus",
		...args,
	});
};

const tcgEndTurnAction = (
	args: ActionHandlerArgs<ActionTcgEndTurn>,
	client: Client,
) => {
	const [lobby, enemy] = getEnemy(client);
	if (!lobby || !enemy) return;

	// Send tcgStartTurn to the other player with the same parameters
	enemy.sendAction({
		action: "tcgStartTurn",
		...args,
	});
};

const moddedAction = (
	args: ActionHandlerArgs<ActionModdedRequest>,
	client: Client,
) => {
	const lobby = client.lobby;
	if (!lobby || lobby.players.length < 2) return;

	const target = args.target as string | undefined;
	const { target: _, ...rest } = args;
	const from = lobby.host?.id === client.id ? "host" : "guest";
	const message = {
		action: "moddedAction" as const,
		from,
		...(lobby.multi ? { fromId: client.playerId } : {}),
		...rest,
	} as ActionModded;
	const relayTarget = target ?? "nemesis";

	if (relayTarget === "all") {
		lobby.broadcastAction(message);
	} else {
		lobby.relayToOpponents(client, message);
	}
};

const handyMPExtensionEnable = (
	args: ActionHandlerArgs<ActionHandyMPExtensionEnable>,
	client: Client,
) => {
	if (!client.lobby) return

	client.lobby.handyAllowMPExtension.set(client.id, true)
	client.lobby.broadcastLobbyInfo()
}

const handyMPExtensionDisable = (
	args: ActionHandlerArgs<ActionHandyMPExtensionDisable>,
	client: Client,
) => {
	if (!client.lobby) return

	client.lobby.handyAllowMPExtension.set(client.id, false)
	client.lobby.broadcastLobbyInfo()
}

/**
 * Persist a player's end-of-game replay-log fingerprints. The relay just stores
 * them (keyed by the server seed + lobby/player context); cross-referencing a
 * presented log against these happens elsewhere. Best-effort and side-effect
 * only — it never relays anything to the other client.
 */
const submitLogHashesAction = (
	{ carbon, human, seed, log, gameId }: ActionHandlerArgs<ActionSubmitLogHashes>,
	client: Client,
) => {
	const lobby = client.lobby;
	const complete = recordLogHashes({
		lobbyCode: lobby?.code ?? null,
		serverSeed: lobby?.seed ?? null,
		claimedSeed: seed ?? null,
		gameMode: lobby?.gameMode ?? null,
		username: client.username ?? null,
		modHash: client.modHash ?? null,
		isHost: lobby?.host?.id === client.id,
		carbonHash: carbon,
		humanHash: human,
		carbonLog: log ?? null,
	});
	// The complete package supersedes the live stream — drop it. Only when the
	// full carbon block was actually stored, so an oversized/blob-less submit
	// leaves the streamed partial as the fallback record.
	if (complete && gameId) deleteLiveLog(gameId);
};

/**
 * Append a batch of streamed carbon lines for an in-progress game. Best-effort
 * and side-effect only (never relayed to the other client); rate/size limiting
 * lives in the store so abuse is dropped rather than crashing the relay.
 */
const streamLogLinesAction = (
	{ gameId, lines }: ActionHandlerArgs<ActionStreamLogLines>,
	client: Client,
) => {
	recordLiveLogLines({
		clientId: client.id,
		gameId,
		lobbyCode: client.lobby?.code ?? null,
		username: client.username ?? null,
		lines,
	});
};

const dataSyncAction = (
    { timer }: ActionHandlerArgs<ActionDataSyncRequest>,
    client: Client,
 ) => {
    if (client.eliminated) return
    client.lobby?.sendTimers(client, Number.isNaN(timer) ? undefined : Number(timer))
}

export const actionHandlers = {
	username: usernameAction,
	createLobby: createLobbyAction,
	joinLobby: joinLobbyAction,
	rejoinLobby: rejoinLobbyAction,
	lobbyInfo: lobbyInfoAction,
	leaveLobby: leaveLobbyAction,
	readyLobby: readyLobbyAction,
	unreadyLobby: unreadyLobbyAction,
	keepAlive: keepAliveAction,
	startGame: startGameAction,
	readyBlind: readyBlindAction,
	unreadyBlind: unreadyBlindAction,
	playHand: playHandAction,
	stopGame: stopGameAction,
	gameInfo: gameInfoAction,
	lobbyOptions: lobbyOptionsAction,
	failRound: failRoundAction,
	setAnte: setAnteAction,
	version: versionAction,
	setLocation: setLocationAction,
	newRound: newRoundAction,
	setFurthestBlind: setFurthestBlindAction,
	skip: skipAction,
	sendPhantom: sendPhantomAction,
	removePhantom: removePhantomAction,
	asteroid: asteroidAction,
	letsGoGamblingNemesis: letsGoGamblingNemesisAction,
	eatPizza: eatPizzaAction,
	soldJoker: soldJokerAction,
	spentLastShop: spentLastShopAction,
	magnet: magnetAction,
	magnetResponse: magnetResponseAction,
	getEndGameJokers: getEndGameJokersAction,
	receiveEndGameJokers: receiveEndGameJokersAction,
	getNemesisDeck: getNemesisDeckAction,
	receiveNemesisDeck: receiveNemesisDeckAction,
	endGameStatsRequested: requestNemesisStatsActionHandler,
	nemesisEndGameStats: receiveNemesisStatsActionHandler,
	startAnteTimer: startAnteTimerAction,
	pauseAnteTimer: pauseAnteTimerAction,
	failTimer: failTimerAction,
	syncClient: syncClientAction,
	submitLogHashes: submitLogHashesAction,
	streamLogLines: streamLogLinesAction,
	tcgServerVersion: tcgServerVersionAction,
	startTcgBetting: startTcgBettingAction,
	tcgBet: tcgBetAction,
	tcgPlayerStatus: tcgPlayerStatusAction,
	tcgEndTurn: tcgEndTurnAction,
	moddedAction: moddedAction,
	handyMPExtensionEnable: handyMPExtensionEnable,
	handyMPExtensionDisable: handyMPExtensionDisable,
    failPvPTimer: failPvPTimerAction,
    dataSync: dataSyncAction,
} satisfies Partial<ActionHandlers>;

/** Server-internal handler for connection drops (not a client action) */
export { disconnectFromLobbyAction };
