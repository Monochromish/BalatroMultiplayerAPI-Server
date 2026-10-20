import assert from 'node:assert/strict'
import { beforeEach, describe, mock, test } from 'node:test'
import { Player, lobby, play, readyAll, reset, start } from './helpers.js'

beforeEach(reset)

describe('lobby', () => {
	test('lobbyInfo lists every player and who the recipient is', () => {
		const { players } = lobby(['a', 'b', 'c'])
		const [a, b, c] = players
		const info = c.last('lobbyInfo')
		assert.deepEqual(
			(info?.players as { id: number; username: string; isHost: boolean }[]).map((p) => [p.id, p.username, p.isHost]),
			[
				[1, 'a~1', true],
				[2, 'b~1', false],
				[3, 'c~1', false],
			],
		)
		assert.equal(info?.selfId, 3)
		assert.equal(info?.maxPlayers, 3)
		assert.equal(info?.isHost, false)
		assert.equal(info?.host, 'a~1')
		assert.equal(info?.guest, 'b~1')
		assert.equal(a.last('lobbyInfo')?.isHost, true)
		assert.equal(a.last('lobbyInfo')?.selfId, 1)
		assert.equal(b.last('lobbyInfo')?.selfId, 2)
	})

	test('lobbies hold two players unless the host raises max_players', () => {
		const host = new Player('h')
		host.send('createLobby', { gameMode: 'attrition' })
		const code = host.client.lobby?.code
		new Player('g').send('joinLobby', { code })
		const third = new Player('x')
		third.send('joinLobby', { code })
		assert.equal(third.last('error')?.message, 'Lobby is full or does not exist.')

		host.send('lobbyOptions', { max_players: 3 })
		third.send('joinLobby', { code })
		assert.equal(third.client.lobby?.code, code)
		const fourth = new Player('y')
		fourth.send('joinLobby', { code })
		assert.equal(fourth.last('error')?.message, 'Lobby is full or does not exist.')
	})

	test('a mod without multi-player lobbies cannot join a bigger lobby and caps one it is in', () => {
		const { code } = lobby(['a', 'b', 'c'], { max_players: 4 })
		const old = new Player('old', null)
		old.send('joinLobby', { code })
		assert.match(String(old.last('error')?.message), /Update the Multiplayer mod/)

		const host = new Player('h')
		host.send('createLobby', { gameMode: 'attrition' })
		const code2 = host.client.lobby?.code
		new Player('old2', null).send('joinLobby', { code: code2 })
		host.send('lobbyOptions', { max_players: 4 })
		const late = new Player('late')
		late.send('joinLobby', { code: code2 })
		assert.equal(late.last('error')?.message, 'Lobby is full or does not exist.')
	})

	test('no joining a game in progress, and no starting alone', () => {
		const solo = new Player('solo')
		solo.send('createLobby', { gameMode: 'attrition' })
		solo.send('startGame')
		assert.equal(solo.got('startGame').length, 0)

		const { code, players } = lobby(['a', 'b'], { max_players: 3 })
		players[0].send('startGame')
		const late = new Player('late')
		late.send('joinLobby', { code })
		assert.equal(late.last('error')?.message, 'Game already in progress.')
	})

	test('a game with more than two players says so and sends everyone their lives', () => {
		const { players } = lobby(['a', 'b', 'c'], { starting_lives: 3 })
		players[0].send('startGame')
		for (const p of players) {
			assert.equal(p.last('startGame')?.playerCount, 3)
			assert.equal(p.last('playerInfo')?.lives, 3)
			const info = p.last('playersInfo')?.players as { id: number; lives: number; alive: boolean }[]
			assert.deepEqual(
				info.map((x) => [x.id, x.lives, x.alive]),
				[
					[1, 3, true],
					[2, 3, true],
					[3, 3, true],
				],
			)
		}
	})
})

describe('PvP blind with three players', () => {
	test('the blind starts only when everyone is ready, with firstPlayer per recipient', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		b.send('readyBlind')
		a.send('readyBlind')
		assert.equal(a.got('startBlind').length, 0)
		c.send('readyBlind')
		// b readied first: b is told its own role, everyone else the other role
		assert.equal(b.last('startBlind')?.firstPlayer, 'guest')
		assert.equal(c.last('startBlind')?.firstPlayer, 'host')
		assert.equal(a.last('startBlind')?.firstPlayer, 'guest')
		assert.equal(b.got('speedrun').length, 1)
		assert.equal(a.got('speedrun').length, 1)
		assert.equal(c.got('speedrun').length, 1)
	})

	test('below the average of the others loses a life; at or above it does not', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		for (const p of players) p.take()
		play(a, 300, 0)
		play(b, 200, 0)
		play(c, 100, 0)
		// a: 300 vs avg(200,100)=150, b: 200 vs avg(300,100)=200 (tie is safe), c: 100 vs 250
		assert.deepEqual(a.got('endPvP'), [{ action: 'endPvP', lost: false }])
		assert.deepEqual(b.got('endPvP'), [{ action: 'endPvP', lost: false }])
		assert.deepEqual(c.got('endPvP'), [{ action: 'endPvP', lost: true }])
		assert.equal(c.last('playerInfo')?.lives, 3)
		assert.equal(a.got('playerInfo').length, 0)
		assert.equal(b.got('playerInfo').length, 0)
	})

	test('each player is shown the average of the others, rounded up', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(a, 0, 4)
		play(b, 0, 4)
		play(c, 0, 4)
		play(a, 301, 3)
		play(b, 200, 3)
		assert.equal(c.last('enemyInfo')?.score, '251')
		assert.equal(a.last('enemyInfo')?.score, '100')
		assert.equal(b.last('enemyInfo')?.score, '151')
		assert.equal(c.last('enemyInfo')?.handsLeft, 3)
	})

	test('a player out of hands waits while the result can still change', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(a, 500, 0)
		play(b, 300, 2)
		play(c, 100, 0)
		// c is already below and out of hands, but a's target still depends on b
		assert.equal(a.got('endPvP').length, 0)
		assert.equal(c.got('endPvP').length, 0)
		play(b, 900, 1)
		assert.equal(a.got('endPvP').length, 0)
		play(b, 950, 0)
		// a: 500 vs avg(950,100)=525 below; b: 950 vs 300; c: 100 vs 725
		assert.deepEqual(a.last('endPvP'), { action: 'endPvP', lost: true })
		assert.deepEqual(b.last('endPvP'), { action: 'endPvP', lost: false })
		assert.deepEqual(c.last('endPvP'), { action: 'endPvP', lost: true })
	})

	test('the blind ends early once every result is settled', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(b, 100, 0)
		play(c, 100, 0)
		play(a, 5000, 2)
		// a is still playing but nothing a does can change anyone's result
		assert.deepEqual(a.last('endPvP'), { action: 'endPvP', lost: false })
		assert.deepEqual(b.last('endPvP'), { action: 'endPvP', lost: true })
		assert.deepEqual(c.last('endPvP'), { action: 'endPvP', lost: true })
	})

	test('a stray hand after the blind ends does not end it again', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(b, 100, 0)
		play(c, 100, 0)
		play(a, 5000, 2)
		play(a, 6000, 1)
		assert.equal(a.got('endPvP').length, 1)
		assert.equal(b.got('playerInfo').length, 1)
	})
})

describe('elimination', () => {
	test('running out of lives takes a player out while the rest carry on', () => {
		const { players } = start(['a', 'b', 'c'], 1)
		const [a, b, c] = players
		readyAll(players)
		for (const p of players) p.take()
		play(a, 300, 0)
		play(b, 200, 0)
		play(c, 100, 0)
		assert.equal(c.got('loseGame').length, 1)
		assert.equal(c.got('endPvP').length, 0)
		assert.equal(a.got('winGame').length, 0)
		assert.equal(a.got('endPvP').length, 1)
		const standings = a.last('playersInfo')?.players as { id: number; alive: boolean; place: number }[]
		assert.deepEqual(standings.find((p) => p.id === 3), { ...standings.find((p) => p.id === 3), alive: false, place: 3 })

		// the eliminated player no longer takes part
		for (const p of players) p.take()
		readyAll([a, b])
		assert.equal(a.got('startBlind').length, 1)
		assert.equal(c.got('startBlind').length, 0)
		c.send('playHand', { score: '999999', handsLeft: 0 })
		assert.equal(a.got('enemyInfo').length, 0)
	})

	test('when two are left the game is decided like 1v1', () => {
		const { players } = start(['a', 'b', 'c'], 1)
		const [a, b, c] = players
		readyAll(players)
		play(a, 300, 0)
		play(b, 200, 0)
		play(c, 100, 0)
		for (const p of players) p.take()
		readyAll([a, b])
		play(a, 100, 0)
		play(b, 50, 0)
		assert.equal(a.got('winGame').length, 1)
		assert.equal(b.got('loseGame').length, 1)
		assert.equal(a.got('endPvP').length, 0)
		assert.equal(b.got('endPvP').length, 0)
		const standings = a.last('playersInfo')?.players as { id: number; place: number }[]
		assert.deepEqual(
			standings.map((p) => [p.id, p.place]),
			[
				[1, 1],
				[2, 2],
				[3, 3],
			],
		)
	})

	test('losing your last life outside PvP with death_on_round_loss', () => {
		const { players } = start(['a', 'b', 'c'], 1, { death_on_round_loss: true })
		const [a, b, c] = players
		c.send('failRound')
		assert.equal(c.got('loseGame').length, 1)
		assert.equal(a.got('winGame').length, 0)
		b.send('failRound')
		assert.equal(b.got('loseGame').length, 1)
		assert.equal(a.got('winGame').length, 1)
	})

	test("an elimination while the others wait at blind select starts the blind", () => {
		const { players } = start(['a', 'b', 'c'], 1, { death_on_round_loss: true })
		const [a, b, c] = players
		a.send('readyBlind')
		b.send('readyBlind')
		c.send('failRound')
		assert.equal(a.got('startBlind').length, 1)
		assert.equal(b.got('startBlind').length, 1)
	})

	test("a player's phantoms leave the other boards when they are out", () => {
		const { players } = start(['a', 'b', 'c'], 1, { death_on_round_loss: true })
		const [a, b, c] = players
		c.send('sendPhantom', { key: 'j_mp_pizza' })
		c.send('sendPhantom', { key: 'j_mp_pizza' })
		c.send('sendPhantom', { key: 'j_mp_speedrun' })
		c.send('removePhantom', { key: 'j_mp_speedrun' })
		assert.equal(a.got('sendPhantom').length, 3)
		assert.equal(b.got('sendPhantom').length, 3)
		a.take()
		c.send('failRound')
		assert.deepEqual(a.got('removePhantom'), [
			{ action: 'removePhantom', key: 'j_mp_pizza' },
			{ action: 'removePhantom', key: 'j_mp_pizza' },
		])
	})
})

describe('PvP timer', () => {
	test('timer rights go to players ahead of their target, per recipient', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(a, 0, 4)
		play(b, 0, 4)
		play(c, 0, 4)
		play(a, 500, 3)
		play(b, 100, 3)
		// a is ahead (500 vs 50), b is behind (100 vs 250), c is behind (0 vs 300)
		assert.equal(a.last('enemyInfo')?.pvpTimerOrder, 'host')
		assert.equal(b.last('enemyInfo')?.pvpTimerOrder, 'host')
		assert.equal(c.last('enemyInfo')?.pvpTimerOrder, 'host')

		a.send('startAnteTimer', { time: 30, isPvP: true })
		assert.equal(b.got('startAnteTimer').length, 1)
		assert.equal(c.got('startAnteTimer').length, 1)
		assert.equal(a.got('startAnteTimer').length, 0)

		// b overtakes a: a loses rights, so a's timer on c stops; b's on c doesn't exist
		play(b, 2000, 2)
		assert.equal(b.last('enemyInfo')?.pvpTimerOrder, 'guest')
		assert.equal(a.last('enemyInfo')?.pvpTimerOrder, 'guest')
		assert.equal(c.got('pauseAnteTimer').length, 1)
	})

	test('a player who loses on the timer is done; the others play on', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(a, 900, 0)
		play(c, 700, 0)
		play(b, 100, 3)
		for (const p of players) p.take()
		b.send('failPvPTimer')
		assert.deepEqual(b.got('endPvP'), [{ action: 'endPvP', lost: true, pvpTimerLost: true }])
		assert.equal(b.last('playerInfo')?.lives, 3)
		// a and c were only waiting on b, so the blind ends; b loses no second life
		assert.deepEqual(a.got('endPvP'), [{ action: 'endPvP', lost: false }])
		assert.deepEqual(c.got('endPvP'), [{ action: 'endPvP', lost: false }])
		assert.equal(b.got('endPvP').length, 1)
		assert.equal(b.got('playerInfo').length, 1)
	})

	test("a timer loser's next blind does not change the others' targets", () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(a, 1000, 2)
		play(b, 400, 2)
		play(c, 600, 2)
		b.send('failPvPTimer')
		for (const p of players) p.take()
		// b moves on to the next small blind
		play(b, 0, 4)
		assert.equal(c.got('enemyInfo').length, 0)
		play(a, 1000, 0)
		play(c, 600, 0)
		// c: 600 vs avg(1000, 400 frozen)=700, below
		assert.deepEqual(c.last('endPvP'), { action: 'endPvP', lost: true })
		assert.equal(b.got('endPvP').length, 0)
	})

	test('when the last two still playing are timed out with nobody left, the blind still ends', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(a, 50, 3)
		play(b, 50, 3)
		play(c, 50, 3)
		a.send('failPvPTimer')
		b.send('failPvPTimer')
		// only c is left unresolved: c takes the blind outright, as in 1v1
		assert.deepEqual(c.last('endPvP'), { action: 'endPvP', lost: false, pvpTimerLost: true })
	})

	test('a leader still playing can be timered once nobody behind is', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(a, 800, 0)
		play(b, 500, 0)
		play(c, 1000, 3)
		// a is not below (800 vs 750) but its result depends on c, who could stall
		assert.equal(a.got('endPvP').length, 0)
		assert.equal(c.last('enemyInfo')?.pvpTimerOrder, 'host')
		assert.equal(a.last('enemyInfo')?.pvpTimerOrder, 'host')
		a.take()
		c.take()
		a.send('startAnteTimer', { time: 30, isPvP: true })
		assert.equal(c.got('startAnteTimer').length, 1)
		c.send('failPvPTimer')
		assert.deepEqual(a.last('endPvP'), { action: 'endPvP', lost: false })
		assert.deepEqual(b.last('endPvP'), { action: 'endPvP', lost: true })
	})

	test('the ante timer reaches players not ready and stops when the last starter pauses', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		a.send('readyBlind')
		b.send('readyBlind')
		for (const p of players) p.take()
		a.send('startAnteTimer', { time: 100 })
		b.send('startAnteTimer', { time: 90 })
		assert.deepEqual(c.got('startAnteTimer'), [{ action: 'startAnteTimer', time: 100 }])
		assert.equal(b.got('startAnteTimer').length, 0)
		a.send('pauseAnteTimer', { time: 80 })
		assert.equal(c.got('pauseAnteTimer').length, 0)
		b.send('pauseAnteTimer', { time: 70 })
		assert.deepEqual(c.got('pauseAnteTimer'), [{ action: 'pauseAnteTimer', time: 70 }])
	})
})

describe('opponent effects', () => {
	test('Taxes sees the average number of cards sold by opponents', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		a.send('soldJoker')
		assert.equal(b.got('soldJoker').length, 0)
		a.send('soldJoker')
		assert.equal(b.got('soldJoker').length, 1)
		assert.equal(c.got('soldJoker').length, 1)
		b.send('soldJoker')
		assert.equal(c.got('soldJoker').length, 1)
		c.send('soldJoker')
		assert.equal(a.got('soldJoker').length, 1)
	})

	test('Penny Pincher sees the average shop spend, blind by blind, with skips as 0', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		b.send('spentLastShop', { amount: 10 })
		assert.equal(a.got('spentLastShop').length, 0)
		c.send('skip', { skips: 1 })
		assert.deepEqual(a.got('spentLastShop'), [{ action: 'spentLastShop', amount: 5 }])
		c.send('spentLastShop', { amount: 7 })
		b.send('spentLastShop', { amount: 4 })
		assert.deepEqual(a.got('spentLastShop').map((m) => m.amount), [5, 5])
		assert.deepEqual(b.got('spentLastShop'), [])
	})

	test('Magnet copies from one opponent and only the requester gets the joker', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		a.send('magnet')
		const asked = [b, c].filter((p) => p.got('magnet').length === 1)
		assert.equal(asked.length, 1)
		asked[0].send('magnetResponse', { key: 'SAVE' })
		assert.deepEqual(a.got('magnetResponse'), [{ action: 'magnetResponse', key: 'SAVE' }])
		const other = asked[0] === b ? c : b
		assert.equal(other.got('magnetResponse').length, 0)
	})

	test('asteroid, pizza and gambling reach every opponent', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		a.send('asteroid')
		a.send('eatPizza', { whole: 1 })
		a.send('letsGoGamblingNemesis')
		for (const p of [b, c]) {
			assert.equal(p.got('asteroid').length, 1)
			assert.equal(p.got('eatPizza').length, 1)
			assert.equal(p.got('letsGoGamblingNemesis').length, 1)
		}
		assert.equal(a.got('asteroid').length, 0)
	})

	test("the opponents' skip count shown never goes down", () => {
		const { players } = start(['a', 'b', 'c'], 1, { death_on_round_loss: true })
		const [a, b, c] = players
		b.send('skip', { skips: 3 })
		assert.equal(a.last('enemyInfo')?.skips, 2)
		c.send('failRound')
		b.send('skip', { skips: 3 })
		assert.equal(a.last('enemyInfo')?.skips, 3)
		const shown = a.got('enemyInfo').map((m) => m.skips as number)
		assert.deepEqual(shown, [...shown].sort((x, y) => x - y))
	})

	test('the opponent timer shown is the lowest one', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		b.send('dataSync', { timer: 40 })
		c.send('dataSync', { timer: 25 })
		b.send('dataSync', { timer: 30 })
		assert.equal(a.last('dataSync')?.timer, 25)
		assert.equal(c.last('dataSync')?.timer, 30)
	})

	test('modded actions say which player sent them', () => {
		const { players } = start(['a', 'b', 'c'])
		const [, b, c] = players
		c.send('moddedAction', { modId: 'm', modAction: 'x' })
		assert.equal(b.last('moddedAction')?.fromId, 3)
		assert.equal(b.last('moddedAction')?.from, 'guest')
	})
})

describe('end of game', () => {
	test("an eliminated player's end screen shows the leader", () => {
		const { players } = start(['a', 'b', 'c'], 1, { death_on_round_loss: true })
		const [a, b, c] = players
		b.send('skip', { skips: 1 })
		c.send('failRound')
		c.send('getEndGameJokers')
		c.send('getEndGameJokers')
		const target = [a, b].find((p) => p.got('getEndGameJokers').length > 0)
		assert.ok(target)
		target.send('receiveEndGameJokers', { keys: 'J1' })
		target.send('receiveEndGameJokers', { keys: 'J2' })
		assert.deepEqual(c.got('receiveEndGameJokers').map((m) => m.keys), ['J1', 'J2'])
		const other = target === a ? b : a
		assert.equal(other.got('receiveEndGameJokers').length, 0)
	})

	test("the winner's end screen shows the last player eliminated", () => {
		const { players } = start(['a', 'b', 'c'], 1, { death_on_round_loss: true })
		const [a, b, c] = players
		c.send('failRound')
		b.send('failRound')
		a.send('getNemesisDeck')
		assert.equal(b.got('getNemesisDeck').length, 1)
		assert.equal(c.got('getNemesisDeck').length, 0)
		b.send('receiveNemesisDeck', { cards: 'H_A' })
		assert.deepEqual(a.got('receiveNemesisDeck'), [{ action: 'receiveNemesisDeck', cards: 'H_A' }])
	})

	test('going back to the lobby when out only takes you back', () => {
		const { players } = start(['a', 'b', 'c'], 1, { death_on_round_loss: true })
		const [a, b, c] = players
		c.send('failRound')
		for (const p of players) p.take()
		c.send('stopGame')
		assert.equal(c.got('stopGame').length, 1)
		assert.equal(a.got('stopGame').length, 0)
		assert.equal(b.got('stopGame').length, 0)
	})

	test('quitting with two others left is a loss; quitting at the final two hands the other the win', () => {
		const { players } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		c.send('stopGame')
		assert.equal(c.got('stopGame').length, 1)
		assert.equal(a.got('stopGame').length, 0)
		b.send('stopGame')
		assert.equal(a.got('winGame').length, 1)
		assert.equal(a.got('stopGame').length, 0)
		// after the result anyone returning sends everybody back
		a.send('stopGame')
		assert.equal(b.got('stopGame').length, 2)
	})

	test('the host cannot start or reconfigure a game that is still running', () => {
		const { players } = start(['a', 'b', 'c'], 1, { death_on_round_loss: true })
		const [a, b, c] = players
		a.send('failRound')
		a.send('stopGame')
		for (const p of players) p.take()
		a.send('lobbyOptions', { death_on_round_loss: 'false' })
		assert.equal(b.got('lobbyOptions').length, 0)
		a.send('startGame')
		assert.equal(b.got('startGame').length, 0)
		// the change still applies to the next game
		b.send('failRound')
		assert.equal(c.got('winGame').length, 1)
		c.send('stopGame')
		assert.equal(b.last('lobbyOptions')?.death_on_round_loss, 'false')
	})

	test('leaving mid-game takes the player out and the others play on', () => {
		const { players, lobby: l } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll([a, b])
		c.send('leaveLobby')
		assert.equal(a.got('startBlind').length, 1)
		assert.equal(l.players.length, 2)
		assert.equal(a.got('stopGame').length, 0)
		assert.equal((a.last('lobbyInfo')?.players as unknown[]).length, 2)
		void b
	})
})

describe('disconnects', () => {
	test('the others are told without pausing their game, and the blind waits for a rejoin', () => {
		const { players, code } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		c.send('readyBlind')
		c.drop()
		assert.deepEqual(a.last('playerDisconnected'), { action: 'playerDisconnected', id: 3, timeout: 60 })
		assert.equal(a.got('enemyDisconnected').length, 0)
		readyAll([a, b])
		assert.equal(a.got('startBlind').length, 0)
		a.send('soldJoker')
		a.send('soldJoker')
		c.take()
		c.rejoin(code)
		assert.equal(c.inbox[0].action, 'rejoinedLobby')
		assert.equal(c.got('soldJoker').length, 1)
		assert.equal(a.got('playerReconnected').length, 1)
		assert.equal(a.got('startBlind').length, 1)
		assert.equal(c.got('startBlind').length, 1)
	})

	test('missing the grace period takes the player out', () => {
		mock.timers.enable({ apis: ['setTimeout'] })
		try {
			const { players } = start(['a', 'b', 'c'])
			const [a, b, c] = players
			readyAll([a, b])
			c.drop()
			mock.timers.tick(60000)
			assert.equal(a.got('startBlind').length, 1)
			assert.equal(b.got('startBlind').length, 1)
			const standings = a.last('playersInfo')?.players as { id: number }[]
			assert.deepEqual(standings.map((p) => p.id), [1, 2])
		} finally {
			mock.timers.reset()
		}
	})

	test('a player who drops during a PvP blind gets its result on rejoin', () => {
		const { players, code } = start(['a', 'b', 'c'])
		const [a, b, c] = players
		readyAll(players)
		play(c, 100, 0)
		c.drop()
		play(a, 300, 0)
		play(b, 200, 0)
		assert.equal(a.got('endPvP').length, 1)
		c.rejoin(code)
		assert.deepEqual(c.got('endPvP'), [{ action: 'endPvP', lost: true }])
		assert.equal(c.last('playerInfo')?.lives, 3)
	})
})

describe('survival', () => {
	test('a dead player loses once someone gets further; ties at the end all win', () => {
		const { players } = start(['a', 'b', 'c'], 1, { gameMode: 'survival', death_on_round_loss: true })
		const [a, b, c] = players
		a.send('setFurthestBlind', { furthestBlind: 5 })
		b.send('setFurthestBlind', { furthestBlind: 5 })
		c.send('setFurthestBlind', { furthestBlind: 3 })
		c.send('failRound')
		assert.equal(c.got('loseGame').length, 1)
		a.send('failRound')
		assert.equal(a.got('loseGame').length, 0)
		b.send('failRound')
		assert.equal(a.got('winGame').length, 1)
		assert.equal(b.got('winGame').length, 1)
	})

	test('dying ahead of everyone still standing waits for them', () => {
		const { players } = start(['a', 'b', 'c'], 1, { gameMode: 'survival', death_on_round_loss: true })
		const [a, b, c] = players
		a.send('setFurthestBlind', { furthestBlind: 9 })
		b.send('setFurthestBlind', { furthestBlind: 3 })
		c.send('setFurthestBlind', { furthestBlind: 2 })
		a.send('failRound')
		c.send('failRound')
		assert.equal(c.got('loseGame').length, 1)
		assert.equal(a.got('winGame').length, 0)
		assert.equal(b.got('winGame').length, 0)
		b.send('setFurthestBlind', { furthestBlind: 10 })
		assert.equal(a.got('loseGame').length, 1)
		assert.equal(b.got('winGame').length, 1)
	})
})
