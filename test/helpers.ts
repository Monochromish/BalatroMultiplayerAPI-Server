import Client from '../src/Client.js'
import { Lobbies } from '../src/Lobby.js'
import { actionHandlers, disconnectFromLobbyAction } from '../src/actionHandlers.js'

// actions main.ts dispatches without an args object
const NO_ARGS = new Set([
	'lobbyInfo',
	'leaveLobby',
	'readyLobby',
	'unreadyLobby',
	'startGame',
	'readyBlind',
	'unreadyBlind',
	'keepAlive',
	'stopGame',
	'gameInfo',
	'newRound',
	'failRound',
	'asteroid',
	'letsGoGamblingNemesis',
	'soldJoker',
	'magnet',
	'getEndGameJokers',
	'getNemesisDeck',
	'failTimer',
	'failPvPTimer',
	'endGameStatsRequested',
	'startTcgBetting',
])

export type Msg = { action: string; [key: string]: unknown }

export class Player {
	client: Client
	inbox: Msg[] = []
	name: string

	constructor(name: string, maxPlayers: number | null = 8) {
		this.name = name
		this.client = this.connect()
		this.send('username', {
			username: `${name}~1`,
			modHash: 'HASH',
			...(maxPlayers === null ? {} : { maxPlayers }),
		})
	}

	connect() {
		const client = new Client(
			{},
			(action) => {
				this.inbox.push(JSON.parse(JSON.stringify(action)))
			},
			() => {},
		)
		this.client = client
		return client
	}

	send(action: string, args: Record<string, unknown> = {}) {
		// biome-ignore lint/suspicious/noExplicitAny: dispatching like main.ts
		const handler = (actionHandlers as any)[action]
		if (NO_ARGS.has(action)) handler(this.client)
		else handler(args, this.client)
	}

	/** Messages received since the last take() */
	take(): Msg[] {
		const out = this.inbox
		this.inbox = []
		return out
	}

	got(action: string): Msg[] {
		return this.inbox.filter((m) => m.action === action)
	}

	last(action: string): Msg | undefined {
		return this.got(action).pop()
	}

	drop() {
		disconnectFromLobbyAction(this.client)
	}

	rejoin(code: string) {
		const token = this.client.reconnectToken
		this.connect()
		this.send('rejoinLobby', { code, reconnectToken: token })
	}
}

export function reset() {
	for (const lobby of Lobbies.values()) {
		for (const slot of lobby.disconnectedSlots.values()) clearTimeout(slot.timer)
	}
	Lobbies.clear()
}

/** A lobby with the given players joined; the first is the host */
export function lobby(names: string[], options: Record<string, unknown> = {}) {
	const players = names.map((n) => new Player(n))
	const [host, ...guests] = players
	host.send('createLobby', { gameMode: options.gameMode ?? 'attrition' })
	const code = host.client.lobby?.code as string
	host.send('lobbyOptions', { max_players: names.length, ...options })
	for (const guest of guests) guest.send('joinLobby', { code })
	return { players, code, lobby: host.client.lobby! }
}

/** Starts the game with every player at `lives` */
export function start(names: string[], lives = 4, options: Record<string, unknown> = {}) {
	const made = lobby(names, { starting_lives: lives, ...options })
	made.players[0].send('startGame')
	for (const p of made.players) p.take()
	return made
}

/** Everyone still in readies, which starts the PvP blind */
export function readyAll(players: Player[]) {
	for (const p of players) p.send('readyBlind')
}

export function play(p: Player, score: string | number, handsLeft: number) {
	p.send('playHand', { score: String(score), handsLeft })
}
