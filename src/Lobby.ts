import type Client from "./Client.js";
import { InsaneInt } from "./InsaneInt.js";
import GameModes from "./GameMode.js";
import type {
	ActionLobbyInfo,
	ActionServerToClient,
	GameMode,
} from "./actions.js";
import {
	compare,
	compareToMean,
	formatScore,
	meanTarget,
	parseScore,
} from "./score.js";

export const Lobbies = new Map<string, Lobby>();

/** Lobby size when the host hasn't picked one, and all that mods without
 *  multi-player lobbies can show */
export const DEFAULT_MAX_PLAYERS = 2;
export const MAX_PLAYERS = 8;

const generateUniqueLobbyCode = (): string => {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	let result = "";
	for (let i = 0; i < 5; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return Lobbies.get(result) ? generateUniqueLobbyCode() : result;
};

/** The only other player in the lobby, or null when there are several (TCG is 1v1) */
export const getEnemy = (client: Client): [Lobby | null, Client | null] => {
	const lobby = client.lobby
	if (!lobby) return [null, null]
	if (!lobby.players.includes(client)) return [lobby, null]
	const others = lobby.players.filter((p) => p !== client)
	return [lobby, others.length === 1 ? others[0] : null]
}

const scoreOf = (client: Client) => parseScore(client.score.toString());

const mean = (values: number[]) =>
	values.reduce((sum, v) => sum + v, 0) / values.length;

// The mod compares role strings (startBlind.firstPlayer, enemyInfo.pvpTimerOrder)
// against its own role, so each recipient gets its own role when the fact is
// about them and the other role when it isn't.
const roleFor = (lobby: Lobby, recipient: Client, aboutRecipient: boolean) =>
	aboutRecipient === (lobby.host === recipient) ? "host" : "guest";

/** How long to keep a disconnected player's slot reserved (ms) */
const RECONNECT_GRACE_PERIOD = 60000;
/** Messages kept for a disconnected player to replay when they rejoin */
const MAX_MISSED_MESSAGES = 1000;

/** Game state a rejoining connection takes over from the dropped one */
const CARRIED_OVER = [
	"lives",
	"score",
	"handsLeft",
	"ante",
	"skips",
	"furthestBlind",
	"isReady",
	"firstReady",
	"isReadyLobby",
	"roundLivesBlocker",
	"timerLivesBlocker",
	"location",
	"username",
	"modHash",
	"playerId",
	"maxPlayers",
	"eliminated",
	"place",
	"readyAt",
	"inPvP",
	"pvpResolved",
	"timeredBy",
	"phantoms",
	"sells",
	"soldTicksSent",
	"shopSpends",
	"shopSpendsSent",
	"pendingRequests",
	"skipsShown",
	"lastTimer",
] as const;

interface DisconnectedSlot {
	client: Client;
	timer: ReturnType<typeof setTimeout>;
	missed: ActionServerToClient[];
	/** Players shown the blocking "opponent disconnected" overlay */
	blocked: Client[];
}

class Lobby {
	code: string;
	/** In join order; the first player is the host */
	players: Client[] = [];
	gameMode: GameMode;
	// biome-ignore lint/suspicious/noExplicitAny:
	options: { [key: string]: any };
	tcgBets: Map<string, number>;
    handyAllowMPExtension: Map<string, boolean>;
	firstReadyAt: number | null;
	/** Disconnected players awaiting reconnection, by reconnect token */
	disconnectedSlots = new Map<string, DisconnectedSlot>();
	/** Whether a game is currently in progress */
	isInGame = false;
	/** Authoritative seed generated for the current game (null until startGame,
	 *  or for different-seeds games where each client uses its own). */
	seed: string | null = null;
	/** The current game started with more than two players */
	multi = false;
	/** A winner has been decided and the game is waiting for stopGame */
	matchOver = false;
	/** A PvP blind is being played */
	pvpActive = false;
	eliminationOrder: Client[] = [];
	nextPlayerId = 1;
	/** Options the host changed during a multi-player game, applied once it ends */
	pendingOptions: { [key: string]: unknown } = {};

	// Attrition is the default game mode
	constructor(host: Client, gameMode: GameMode = "attrition") {
		do {
			this.code = generateUniqueLobbyCode();
		} while (Lobbies.get(this.code));
		Lobbies.set(this.code, this);

		host.playerId = this.nextPlayerId++;
		this.players = [host];
		this.gameMode = gameMode;
		this.options = {};
		this.tcgBets = new Map();
        this.handyAllowMPExtension = new Map();
		this.firstReadyAt = null;

		host.setLobby(this);
		host.isReadyLobby = false;
		host.sendAction({
			action: "joinedLobby",
			code: this.code,
			type: this.gameMode,
			reconnectToken: host.reconnectToken,
		});
	}

	get host(): Client | null {
		return this.players[0] ?? null;
	}

	get guest(): Client | null {
		return this.players[1] ?? null;
	}

	static get = (code: string) => {
		return Lobbies.get(code);
	};

	/** The host's max_players option, capped by what every player's mod can show */
	maxPlayers = () => {
		const wanted = Math.floor(Number(this.options.max_players)) || DEFAULT_MAX_PLAYERS;
		const supported = Math.min(...this.players.map((p) => p.maxPlayers));
		return Math.max(DEFAULT_MAX_PLAYERS, Math.min(wanted, supported, MAX_PLAYERS));
	};

	alivePlayers = () => this.players.filter((p) => !p.eliminated);

	getOpponents = (client: Client) =>
		this.players.filter((p) => p !== client && !p.eliminated);

	/** In a game that started with more than two players, someone who quits or
	 *  drops is taken out of it and the others play on */
	playsOnWithout = () => this.multi && this.isInGame && !this.matchOver;

	relayToOpponents = (from: Client, action: ActionServerToClient) => {
		for (const player of this.getOpponents(from)) player.sendAction(action);
	};

	/** Forgets players still in their reconnect grace period */
	dropDisconnected = () => {
		for (const slot of this.disconnectedSlots.values()) {
			clearTimeout(slot.timer);
			this.removePlayer(slot.client);
		}
		this.disconnectedSlots.clear();
	};

	removePlayer = (client: Client) => {
		const index = this.players.indexOf(client);
		if (index !== -1) this.players.splice(index, 1);
		this.handyAllowMPExtension.delete(client.id);
		client.setLobby(null);
	};

	/** Voluntary leave — no grace period */
	leave = (client: Client) => {
		if (this.playsOnWithout()) {
			const wasHost = this.host === client;
			this.eliminate(client, false);
			this.removePlayer(client);
			this.broadcastLobbyInfo();
			this.broadcastPlayersInfo();
			if (wasHost && this.pvpActive) {
				// Roles moved up, so the role strings in pvpTimerOrder changed meaning
				for (const player of this.players) {
					if (player.inPvP && !player.eliminated) this.sendPvPEnemyInfo(player);
				}
			}
			return;
		}

		// Clear any pending reconnect slots for this lobby
		this.disconnectedSlots.delete(client.reconnectToken);
		this.dropDisconnected();

		this.removePlayer(client);
		this.isInGame = false;

		// Check if anyone is still in the lobby
		if (this.players.length === 0) {
			Lobbies.delete(this.code);
		} else {
			// Stop game if someone leaves
			this.broadcastAction({ action: "stopGame" });
			this.resetPlayers();
			this.broadcastLobbyInfo();
		}
	};

	/** Connection lost — use grace period if game is in progress */
	disconnect = (client: Client) => {
		// main.ts reports both the socket's end and its error
		if (!this.players.includes(client) || !client.connected) return;

		// If no game in progress or no other player, do a regular leave
		if (!this.isInGame || !this.players.some((p) => p !== client && p.connected)) {
			this.leave(client);
			return;
		}

		// Reserve the slot with a grace period
		console.log(`Player ${client.id} disconnected from lobby ${this.code}, reserving slot for ${RECONNECT_GRACE_PERIOD / 1000}s (saving state: lives=${client.lives}, score=${client.score}, ante=${client.ante})`)

		const others = this.players.filter((p) => p !== client);
		// 1v1 pauses the opponent; a multi-player game carries on and only the
		// next PvP blind waits for them
		const blocked = this.multi ? [] : others;

		const missed: ActionServerToClient[] = [];
		client.connected = false;
		client.sendAction = (action) => {
			if (missed.length < MAX_MISSED_MESSAGES) missed.push(action);
			else if (missed.length === MAX_MISSED_MESSAGES) {
				console.warn(`Dropping messages for disconnected player ${client.id} in lobby ${this.code}`);
				missed.push({ action: "error", message: "Some messages were lost while disconnected." });
			}
		};
		this.disconnectedSlots.set(client.reconnectToken, {
			client,
			missed,
			blocked,
			timer: setTimeout(() => {
				// Grace period expired, do a full leave
				console.log(`Reconnect grace period expired for lobby ${this.code}`)
				this.disconnectedSlots.delete(client.reconnectToken);
				this.leave(client);
			}, RECONNECT_GRACE_PERIOD),
		});

		// Notify the remaining players with the grace period so they can show a countdown
		for (const player of others) {
			if (blocked.includes(player)) {
				player.sendAction({ action: "enemyDisconnected", timeout: RECONNECT_GRACE_PERIOD / 1000 });
			} else {
				player.sendAction({
					action: "playerDisconnected",
					id: client.playerId,
					timeout: RECONNECT_GRACE_PERIOD / 1000,
				});
			}
		}
		this.broadcastPlayersInfo();
	};

	/** Reconnecting client reclaims their slot */
	rejoin = (newClient: Client, reconnectToken: string): boolean => {
		const slot = this.disconnectedSlots.get(reconnectToken);
		if (!slot) {
			return false;
		}

		clearTimeout(slot.timer);
		this.disconnectedSlots.delete(reconnectToken);
		const old = slot.client;

		// Restore game state from the disconnected player onto the new client
		console.log(`Restoring state for player ${old.playerId} in lobby ${this.code}: lives=${old.lives}, score=${old.score}, ante=${old.ante}, handsLeft=${old.handsLeft}, skips=${old.skips}, location=${old.location}`)
		for (const key of CARRIED_OVER) {
			// biome-ignore lint/suspicious/noExplicitAny: copying same-typed fields
			(newClient as any)[key] = old[key];
		}

		// Take the old connection's place everywhere it is referenced
		this.players[this.players.indexOf(old)] = newClient;
		this.eliminationOrder = this.eliminationOrder.map((p) => (p === old ? newClient : p));
		for (const player of this.players) {
			for (const queue of Object.values(player.pendingRequests)) {
				for (let i = 0; i < queue.length; i++) if (queue[i] === old) queue[i] = newClient;
			}
		}

		// The mod resets its timers when it rejoins
		newClient.timeredBy.clear();
		newClient.setLobby(this);
		this.handyAllowMPExtension.set(newClient.id, false);

		// Send rejoin confirmation with new reconnect token
		newClient.sendAction({
			action: "rejoinedLobby",
			code: this.code,
			type: this.gameMode,
			reconnectToken: newClient.reconnectToken,
		});
		for (const action of slot.missed) newClient.sendAction(action);

		// Notify the other players
		for (const player of this.players) {
			if (player === newClient) continue;
			if (slot.blocked.includes(player)) {
				player.sendAction({ action: "enemyReconnected" });
			} else {
				player.sendAction({ action: "playerReconnected", id: newClient.playerId });
			}
		}

		this.broadcastLobbyInfo();
		this.broadcastPlayersInfo();
		this.checkAllReady();
		return true;
	};

	join = (client: Client) => {
		const maxPlayers = this.maxPlayers();
		if (this.players.length >= maxPlayers) {
			client.sendAction({
				action: "error",
				message: "Lobby is full or does not exist.",
			});
			return;
		}
		if (this.isInGame) {
			client.sendAction({ action: "error", message: "Game already in progress." });
			return;
		}
		if (client.maxPlayers < maxPlayers) {
			client.sendAction({
				action: "error",
				message: `This lobby allows ${maxPlayers} players. Update the Multiplayer mod to join.`,
			});
			return;
		}

		client.playerId = this.nextPlayerId++;
		this.players.push(client);

		client.setLobby(this);
		client.isReadyLobby = false;
        this.handyAllowMPExtension.set(client.id, false)
		client.sendAction({
			action: "joinedLobby",
			code: this.code,
			type: this.gameMode,
			reconnectToken: client.reconnectToken,
		});
		client.sendAction({ action: "lobbyOptions", gamemode: this.gameMode, ...this.options });
		this.broadcastLobbyInfo();
	};

	broadcastAction = (action: ActionServerToClient) => {
		for (const player of this.players) player.sendAction(action);
	};

	broadcastLobbyInfo = () => {
		const host = this.host;
		if (!host) {
			return;
		}

		const action: ActionLobbyInfo = {
			action: "lobbyInfo",
			host: host.username,
			hostHash: host.modHash,
			isHost: false,
			hostCached: host.isCached,
			players: this.players.map((p) => ({
				id: p.playerId,
				username: p.username,
				modHash: p.modHash,
				cached: p.isCached,
				ready: p.isReadyLobby,
				isHost: p === host,
				connected: p.connected,
			})),
			maxPlayers: this.maxPlayers(),
		};

		const guest = this.guest;
		if (guest?.username) {
			action.guest = guest.username;
			action.guestHash = guest.modHash;
			action.guestCached = guest.isCached;
			action.guestReady = guest.isReadyLobby;
		}

		for (const player of this.players) {
			if (player !== host) player.sendAction({ ...action, selfId: player.playerId });
		}

		// Should only sent true to the host
		host.sendAction({ ...action, isHost: true, selfId: host.playerId });

        this.broadcastAction({
            action: "handyMPExtensionLobbyEnabled",
            enabled: Array.from(this.handyAllowMPExtension.values()).every(Boolean)
        })
	};

	/** Per-player state for the mod's multi-player panels; multi-player games only */
	broadcastPlayersInfo = () => {
		if (!this.multi || !this.isInGame) return;
		const hide = Boolean(this.options.hide_score_until_played) && this.pvpActive;
		for (const recipient of this.players) {
			recipient.sendAction({
				action: "playersInfo",
				players: this.players.map((p) => ({
					id: p.playerId,
					username: p.username,
					alive: !p.eliminated,
					place: p.place,
					lives: p.lives,
					score:
						hide && p !== recipient && !recipient.playedThisBlind
							? null
							: p.score.toString(),
					handsLeft: p.handsLeft,
					skips: p.skips,
					location: p.location,
					ready: p.isReady,
					connected: p.connected,
				})),
			});
		}
	};

	setPlayersLives = (lives: number) => {
		for (const player of this.players) player.lives = lives;

		this.broadcastAction({ action: "playerInfo", lives });
	};

	// Deprecated
	sendGameInfo = (client: Client) => {
		if (!this.players.includes(client)) {
			return client.sendAction({
				action: "error",
				message: "Client not in Lobby",
			});
		}

		client.sendAction({
			action: "gameInfo",
			...GameModes[this.gameMode].getBlindFromAnte(client.ante, this.options),
		});
	};

	setOptions = (options: { [key: string]: string }) => {
		if (this.multi && this.isInGame) {
			// An eliminated host back in the lobby can't change the running game
			Object.assign(this.pendingOptions, options);
			return;
		}
		for (const key of Object.keys(options)) {
			if (options[key] === "true" || options[key] === "false") {
				this.options[key] = options[key] === "true";
			} else {
				this.options[key] = options[key];
			}
		}
		for (const player of this.players) {
			if (player !== this.host) {
				player.sendAction({ action: "lobbyOptions", gamemode: this.gameMode, ...options });
			}
		}
	};

	resetPlayers = () => {
		this.isInGame = false;
		this.multi = false;
		if (Object.keys(this.pendingOptions).length > 0) {
			const pending = this.pendingOptions as { [key: string]: string };
			this.pendingOptions = {};
			this.setOptions(pending);
		}
		this.matchOver = false;
		this.pvpActive = false;
		this.eliminationOrder = [];
		for (const player of this.players) {
			player.eliminated = false;
			player.place = 0;
			player.inPvP = false;
			player.pvpResolved = false;
			player.timeredBy.clear();
			player.phantoms.clear();
			player.sells = 0;
			player.soldTicksSent = 0;
			player.shopSpends = [];
			player.shopSpendsSent = 0;
			player.skipsShown = 0;
			player.lastTimer = undefined;
			for (const queue of Object.values(player.pendingRequests)) queue.length = 0;
		}
		for (const player of this.players) {
			player.isReady = false;
			player.resetBlocker();
			player.setLocation("Blind Select");
			player.furthestBlind = 0;
			player.skips = 0;
            player.score = new InsaneInt(0, 0, 0);
		}
		this.tcgBets.clear();
		this.firstReadyAt = null;
	}

	/** Who the PvP target is averaged over for this player */
	scorePool = (player: Client) =>
		this.pvpActive && player.inPvP
			? this.players.filter((p) => p !== player && p.inPvP && !p.eliminated)
			: this.getOpponents(player);

	/** What `enemyInfo` shows a player: their only opponent, or the average of
	 *  their opponents in a multi-player game */
	enemyView = (recipient: Client) => {
		const opponents = this.getOpponents(recipient);
		if (opponents.length === 0) return null;
		if (!this.multi) {
			const enemy = opponents[0];
			return {
				handsLeft: enemy.handsLeft,
				score: enemy.score.toString(),
				skips: enemy.skips,
				lives: enemy.lives,
			};
		}
		const scored = this.scorePool(recipient);
		const pool = scored.length > 0 ? scored : opponents;
		// The mod treats every rise in the opponent's skips as a new skip, so the
		// average must not drop when the set of opponents changes
		recipient.skipsShown = Math.max(
			recipient.skipsShown,
			Math.round(mean(opponents.map((p) => p.skips))),
		);
		return {
			handsLeft: Math.round(mean(pool.map((p) => (p.pvpResolved ? 0 : p.handsLeft)))),
			score: formatScore(meanTarget(pool.map(scoreOf))),
			skips: recipient.skipsShown,
			lives: Math.round(mean(opponents.map((p) => p.lives))),
		};
	};

	/** Refresh what the opponents of `from` see after it changed */
	sendEnemyInfo = (from: Client) => {
		for (const recipient of this.getOpponents(from)) {
			const view = this.enemyView(recipient);
			if (view) recipient.sendAction({ action: "enemyInfo", ...view });
		}
	};

	/** enemyInfo during a PvP blind: hides scores until the recipient has played
	 *  a hand (when enabled) and says who may start the PvP timer */
	sendPvPEnemyInfo = (recipient: Client) => {
		const view = this.enemyView(recipient);
		if (!view) return;
		if (Boolean(this.options.hide_score_until_played) && !recipient.playedThisBlind) {
			recipient.sendAction({
				action: "enemyInfo",
				handsLeft: view.handsLeft,
				score: null,
				skips: view.skips,
				lives: view.lives,
				noScore: true,
			});
		} else {
			recipient.sendAction({
				action: "enemyInfo",
				...view,
				pvpTimerOrder: roleFor(this, recipient, this.holdsTimer(recipient)),
			});
		}
	};

	/** At or above the target, with ties going to whoever readied first */
	isAhead = (player: Client) => {
		const pool = this.scorePool(player);
		const cmp = compareToMean(scoreOf(player), pool.map(scoreOf));
		return cmp > 0 || (cmp === 0 && player.firstReady);
	};

	/**
	 * Whoever is ahead may timer those behind. In a multi-player blind someone
	 * ahead who still has hands loses that once nobody behind is still playing,
	 * so the players who are out of hands can timer them instead of waiting.
	 */
	holdsTimer = (player: Client) => {
		const ahead = this.isAhead(player);
		if (!ahead || !this.multi || !this.pvpActive || player.handsLeft < 1) return ahead;
		return this.players.some(
			(p) =>
				p !== player &&
				p.inPvP &&
				!p.eliminated &&
				!p.pvpResolved &&
				p.handsLeft >= 1 &&
				!this.isAhead(p),
		);
	};

	/** Stops PvP timers whose starters no longer hold timer rights */
	pruneTimers = () => {
		if (!this.multi || !this.pvpActive) return;
		for (const target of this.players) {
			if (target.timeredBy.size === 0) continue;
			if (this.holdsTimer(target)) {
				// the mod stops its own timer once it holds rights
				target.timeredBy.clear();
				continue;
			}
			for (const id of target.timeredBy) {
				const presser = this.players.find((p) => p.playerId === id);
				if (!presser || !this.holdsTimer(presser)) target.timeredBy.delete(id);
			}
			if (target.timeredBy.size === 0) target.sendAction({ action: "pauseAnteTimer" });
		}
	};

	/** What `enemyLocation` shows a player: their only opponent's location, or
	 *  "ready" once every opponent is ready and otherwise someone still choosing */
	enemyLocation = (recipient: Client) => {
		const opponents = this.getOpponents(recipient);
		if (opponents.length === 1) return opponents[0].location;
		const waiting = opponents.find((p) => !p.location.startsWith("loc_ready"));
		return (waiting ?? opponents[0]).location;
	};

	sendEnemyLocations = (from: Client) => {
		for (const recipient of this.getOpponents(from)) {
			recipient.sendAction({ action: "enemyLocation", location: this.enemyLocation(recipient) });
		}
		this.broadcastPlayersInfo();
	};

	/** Starts the PvP blind once every player still in the game is ready */
	checkAllReady = (completing?: Client) => {
		const alive = this.alivePlayers();
		if (alive.length < 2 || !alive.every((p) => p.isReady && p.connected)) return;

		// Grant speedrun to players who readied within 30s of the first
		if (!this.multi) {
			if (completing && this.firstReadyAt && Date.now() - this.firstReadyAt <= 30000) {
				completing.sendAction({ action: "speedrun" });
			}
		} else {
			for (const player of alive) {
				if (!player.firstReady && this.firstReadyAt && player.readyAt - this.firstReadyAt <= 30000) {
					player.sendAction({ action: "speedrun" });
				}
			}
		}
		this.firstReadyAt = null;

		this.pvpActive = true;
		for (const player of alive) {
			// Reset ready status, scores and hands left for next blind
			player.isReady = false;
			player.score = new InsaneInt(0, 0, 0);
			player.handsLeft = 4;
			// Reset per-blind hand-played gate so opponent scores are withheld
			// again at the start of each blind
			player.playedThisBlind = false;
			player.inPvP = true;
			player.pvpResolved = false;
			player.timeredBy.clear();
		}

		const first = alive.filter((p) => p.firstReady).pop();
		for (const player of alive) {
			player.sendAction({
				action: "startBlind",
				firstPlayer: first ? roleFor(this, player, first === player) : undefined,
			});
		}
		this.broadcastPlayersInfo();
	};

	endPvPRound = () => {
		this.pvpActive = false;
		for (const player of this.players) {
			if (player.inPvP) player.firstReady = false;
			player.inPvP = false;
			player.pvpResolved = false;
			player.timeredBy.clear();
		}
		if (this.matchOver) return;
		// Someone who lost on the PvP timer may already be ready for the next blind
		const early = this.alivePlayers()
			.filter((p) => p.isReady)
			.sort((a, b) => a.readyAt - b.readyAt)[0];
		if (early && !this.players.some((p) => p.firstReady)) {
			early.firstReady = true;
			this.firstReadyAt = early.readyAt;
			early.sendAction({ action: "speedrun" });
		}
	};

	/**
	 * Ends the PvP blind once every result is known. A player loses a life when
	 * their score is below the average of the others who started the blind (with
	 * two players: the lower score). A player who is out of hands and already
	 * below can't recover; one who isn't below is safe once the others are out.
	 */
	checkPvPRound = () => {
		if (!this.pvpActive) return;
		if (this.matchOver) {
			this.endPvPRound();
			return;
		}
		const participants = this.players.filter((p) => p.inPvP && !p.eliminated);
		const unresolved = participants.filter((p) => !p.pvpResolved);

		const below = new Map<Client, boolean>();
		for (const player of unresolved) {
			const pool = participants.filter((p) => p !== player).map(scoreOf);
			below.set(player, compareToMean(scoreOf(player), pool) < 0);
		}
		const decided = unresolved.every((player) => {
			if (player.handsLeft < 1 && below.get(player)) return true;
			return !below.get(player) && unresolved.every((p) => p === player || p.handsLeft < 1);
		});
		if (!decided) return;

		this.endPvPRound();
		const losers = unresolved.filter((p) => below.get(p));
		for (const player of losers) player.loseLife("round");
		for (const player of losers) {
			// If no lives are left, they are out
			if (player.lives <= 0) this.eliminate(player);
		}
		if (this.matchOver) return;

		for (const player of unresolved) {
			if (!player.eliminated) player.sendAction({ action: "endPvP", lost: below.get(player) === true });
		}
		this.broadcastPlayersInfo();
	};

	/** A player's PvP timer ran out: they lose a life and finish the blind */
	failPvPTimer = (client: Client) => {
		if (client.lives <= 0) {
			this.eliminate(client);
			return;
		}
		const opponents = this.getOpponents(client);
		if (!this.pvpActive) {
			for (const player of opponents) player.sendAction({ action: "endPvP", lost: false, pvpTimerLost: true });
			client.sendAction({ action: "endPvP", lost: true, pvpTimerLost: true });
			return;
		}

		client.pvpResolved = true;
		client.firstReady = false;
		client.timeredBy.clear();
		const unresolved = this.players.filter((p) => p.inPvP && !p.eliminated && !p.pvpResolved);
		if (unresolved.length === 1) {
			// Last one standing wins the blind outright, as in 1v1
			this.endPvPRound();
			unresolved[0].sendAction({ action: "endPvP", lost: false, pvpTimerLost: true });
		}
		client.sendAction({ action: "endPvP", lost: true, pvpTimerLost: true });
		this.checkPvPRound();
		this.broadcastPlayersInfo();
	};

	/**
	 * Takes a player out of the game. Sends loseGame unless they quit, and
	 * winGame to the last player left.
	 */
	eliminate = (client: Client, notify = true) => {
		if (client.eliminated) return;
		client.eliminated = true;
		client.isReady = false;
		client.place = this.alivePlayers().length + 1;
		this.eliminationOrder.push(client);
		if (notify) client.sendAction({ action: "loseGame" });

		const remaining = this.alivePlayers();
		if (remaining.length <= 1) {
			this.matchOver = true;
			this.endPvPRound();
			for (const winner of remaining) {
				winner.place = 1;
				winner.sendAction({ action: "winGame" });
			}
			this.broadcastPlayersInfo();
			return;
		}

		this.releaseTimers(client);
		for (const [key, count] of client.phantoms) {
			for (let i = 0; i < count; i++) {
				for (const player of remaining) player.sendAction({ action: "removePhantom", key });
			}
		}
		client.phantoms.clear();
		for (const player of remaining) {
			const view = this.enemyView(player);
			if (view) player.sendAction({ action: "enemyInfo", ...view });
			player.sendAction({ action: "enemyLocation", location: this.enemyLocation(player) });
		}
		this.checkPvPRound();
		this.checkAllReady();
		this.sendShopSpends();
		this.broadcastPlayersInfo();
	};

	/**
	 * Survival: a dead player loses once anyone has got further; if everyone
	 * left is dead they are tied for furthest and all win.
	 */
	checkSurvival = () => {
		if (this.matchOver) return;
		for (const player of this.alivePlayers()) {
			if (player.lives > 0) continue;
			if (this.players.some((p) => p !== player && p.furthestBlind > player.furthestBlind)) {
				this.eliminate(player);
				if (this.matchOver) return;
			}
		}
		const left = this.alivePlayers();
		if (left.length > 0 && left.every((p) => p.lives <= 0)) {
			// Survival draw behavior, everyone tied for furthest wins
			this.matchOver = true;
			for (const player of left) {
				player.place = 1;
				player.sendAction({ action: "winGame" });
			}
			this.broadcastPlayersInfo();
		}
	};

	/**
	 * Timers in a multi-player game. A PvP timer goes to everyone still playing
	 * who is below their target; the ante timer to everyone not ready yet. A
	 * player's timer stops when the last player who started it pauses.
	 */
	startTimer = (presser: Client, action: ActionServerToClient, isPvP: boolean) => {
		const targets = isPvP
			? this.players.filter(
					(p) => p !== presser && p.inPvP && !p.eliminated && !p.pvpResolved && !this.holdsTimer(p),
				)
			: this.getOpponents(presser).filter((p) => !p.isReady);
		for (const target of targets) {
			if (isPvP || target.timeredBy.size === 0) target.sendAction(action);
			target.timeredBy.add(presser.playerId);
		}
	};

	pauseTimer = (presser: Client, time?: number) => {
		for (const target of this.players) {
			if (target.timeredBy.delete(presser.playerId) && target.timeredBy.size === 0 && !target.eliminated) {
				target.sendAction({ action: "pauseAnteTimer", time });
			}
		}
	};

	/** Stops everyone's timer on this player, telling them in a multi-player game */
	clearTimers = (target: Client) => {
		if (this.multi && target.timeredBy.size > 0) target.sendAction({ action: "pauseAnteTimer" });
		target.timeredBy.clear();
	};

	releaseTimers = (presser: Client) => {
		if (this.multi) this.pauseTimer(presser);
	};

	/** The opponent timer a player sees: the lowest of their opponents' */
	sendTimers = (from: Client, timer: number | undefined) => {
		if (!this.multi) {
			this.relayToOpponents(from, { action: "dataSync", timer });
			return;
		}
		from.lastTimer = timer;
		for (const recipient of this.getOpponents(from)) {
			const timers = this.getOpponents(recipient)
				.map((p) => p.lastTimer)
				.filter((t): t is number => t !== undefined);
			recipient.sendAction({ action: "dataSync", timer: timers.length > 0 ? Math.min(...timers) : undefined });
		}
	};

	/** Shop spends averaged over each player's opponents, blind by blind */
	sendShopSpends = () => {
		if (!this.multi) return;
		for (const recipient of this.alivePlayers()) {
			const opponents = this.getOpponents(recipient);
			if (opponents.length === 0) continue;
			while (opponents.every((p) => p.shopSpends.length > recipient.shopSpendsSent)) {
				const index = recipient.shopSpendsSent;
				const amount = Math.floor(mean(opponents.map((p) => p.shopSpends[index])));
				recipient.sendAction({ action: "spentLastShop", amount });
				recipient.shopSpendsSent++;
			}
		}
	};

	/** Sold cards averaged over each player's opponents */
	sendSells = () => {
		for (const recipient of this.alivePlayers()) {
			const opponents = this.getOpponents(recipient);
			if (opponents.length === 0) continue;
			const due = Math.floor(mean(opponents.map((p) => p.sells)));
			for (; recipient.soldTicksSent < due; recipient.soldTicksSent++) {
				recipient.sendAction({ action: "soldJoker" });
			}
		}
	};

	/**
	 * Whose board an end screen shows: for a player still in the game the last
	 * one eliminated, for an eliminated player the current leader.
	 */
	endGameTarget = (requester: Client): Client | null => {
		const others = this.players.filter((p) => p !== requester);
		if (others.length <= 1) return others[0] ?? null;
		if (!requester.eliminated) {
			const last = this.eliminationOrder.filter((p) => others.includes(p)).pop();
			if (last) return last;
		}
		const alive = others.filter((p) => !p.eliminated);
		const candidates = alive.length > 0 ? alive : others;
		return candidates.reduce((best, p) =>
			p.lives > best.lives || (p.lives === best.lives && compare(scoreOf(p), scoreOf(best)) > 0) ? p : best,
		);
	};

	requestFrom = (
		target: Client | null,
		requester: Client,
		kind: keyof Client["pendingRequests"],
		action: ActionServerToClient,
	) => {
		if (!target) return;
		target.pendingRequests[kind].push(requester);
		target.sendAction(action);
	};

	/** Routes a reply to whoever asked, oldest request first */
	answerRequest = (
		responder: Client,
		kind: keyof Client["pendingRequests"],
		action: ActionServerToClient,
	) => {
		const requester = responder.pendingRequests[kind].shift();
		if (requester && this.players.includes(requester)) {
			requester.sendAction(action);
			return;
		}
		if (this.multi) return;
		const opponents = this.getOpponents(responder);
		const recipients = opponents.length > 0 ? opponents : this.players.filter((p) => p !== responder);
		for (const player of recipients) player.sendAction(action);
	};
}

export default Lobby;
