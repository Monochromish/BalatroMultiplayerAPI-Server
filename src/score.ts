// Scores arrive as the strings the mod's MP.ACTIONS.play_hand produces:
// plain integers ("12345"), Lua scientific notation ("1.2345678901234e+56"),
// Talisman towers with leading e's ("e1.5e12", "ee308"), or "inf"/"nan".
// Plain and scientific scores are kept as exact bigints so ties and
// "below the average" checks are exact; towers fall back to log10 doubles.

export type Score = {
	infinite: boolean
	// number of leading e's; 0 means `exact` holds the value
	tower: number
	exact: bigint
	// for towers: the mantissa x in e...e(x)
	towerValue: number
}

export const ZERO: Score = {
	infinite: false,
	tower: 0,
	exact: 0n,
	towerValue: 0,
}

const NUMBER_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/

export function parseScore(raw: unknown): Score {
	if (typeof raw === 'number') {
		if (!Number.isFinite(raw)) return { ...ZERO, infinite: true }
		raw = String(raw)
	}
	if (typeof raw !== 'string')
		throw new Error(`score must be a string or number, got ${typeof raw}`)

	let str = raw.trim().toLowerCase().replaceAll(',', '')
	if (
		str === 'inf' ||
		str === '+inf' ||
		str.includes('nan') ||
		str === '1.#inf' ||
		str === 'naneinf'
	) {
		return { ...ZERO, infinite: true }
	}
	if (str === '-inf') return ZERO

	let tower = 0
	while (str.startsWith('e')) {
		tower++
		str = str.slice(1)
	}

	const m = NUMBER_RE.exec(str)
	if (!m || (m[2] === '' && (m[3] ?? '') === ''))
		throw new Error(`unparseable score "${raw}"`)
	const [, sign, intPart, fracPart = '', expPart = '0'] = m

	if (tower > 0) {
		const x = Number(`${sign}${intPart || '0'}.${fracPart || '0'}e${expPart}`)
		if (!Number.isFinite(x)) return { ...ZERO, infinite: true }
		return { infinite: false, tower, exact: 0n, towerValue: x }
	}

	if (sign === '-') return ZERO
	const exp = Number.parseInt(expPart, 10)
	const digits = BigInt(`${intPart || '0'}${fracPart}` || '0')
	const shift = exp - fracPart.length
	if (shift > 100_000) return { ...ZERO, infinite: true }
	const exact =
		shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift)
	return { infinite: false, tower: 0, exact, towerValue: 0 }
}

function log10Big(v: bigint): number {
	if (v <= 0n) return Number.NEGATIVE_INFINITY
	const s = v.toString()
	const head = Number(`0.${s.slice(0, 17)}`)
	return Math.log10(head) + s.length
}

// log10 of the score's value; Infinity when it doesn't fit a double
export function log10Of(s: Score): number {
	if (s.infinite) return Number.POSITIVE_INFINITY
	if (s.tower === 0) return log10Big(s.exact)
	if (s.tower === 1) return s.towerValue
	return Number.POSITIVE_INFINITY
}

// a monotone key for ordering towers that no longer fit in log10 space
function towerKey(s: Score): [number, number] {
	if (s.infinite) return [Number.POSITIVE_INFINITY, 0]
	if (s.tower === 0) {
		const l = log10Big(s.exact)
		return l > 1 ? [1, Math.log10(l)] : [0, l]
	}
	return [s.tower, Math.log10(Math.max(s.towerValue, 1e-300))]
}

export function compare(a: Score, b: Score): number {
	if (a.infinite || b.infinite)
		return a.infinite === b.infinite ? 0 : a.infinite ? 1 : -1
	if (a.tower === 0 && b.tower === 0)
		return a.exact === b.exact ? 0 : a.exact > b.exact ? 1 : -1
	const la = log10Of(a)
	const lb = log10Of(b)
	if (Number.isFinite(la) && Number.isFinite(lb))
		return la === lb ? 0 : la > lb ? 1 : -1
	const [ta, va] = towerKey(a)
	const [tb, vb] = towerKey(b)
	if (ta !== tb) return ta > tb ? 1 : -1
	return va === vb ? 0 : va > vb ? 1 : -1
}

function max(scores: Score[]): Score {
	return scores.reduce((best, s) => (compare(s, best) > 0 ? s : best), ZERO)
}

// log10 of the sum, or null when some term is too large for that to be finite
function log10Sum(scores: Score[]): number | null {
	const logs = scores.map(log10Of)
	if (logs.some((l) => l === Number.POSITIVE_INFINITY)) return null
	const finite = logs.filter((l) => l !== Number.NEGATIVE_INFINITY)
	if (finite.length === 0) return Number.NEGATIVE_INFINITY
	const top = Math.max(...finite)
	return top + Math.log10(finite.reduce((acc, l) => acc + 10 ** (l - top), 0))
}

const sign = (a: number, b: number) => (a === b ? 0 : a > b ? 1 : -1)

// 1, 0 or -1 as `mine` is above, equal to or below the mean of `others`
export function compareToMean(mine: Score, others: Score[]): number {
	if (others.length === 0) return 1
	const othersInfinite = others.some((s) => s.infinite)
	if (mine.infinite || othersInfinite)
		return sign(Number(mine.infinite), Number(othersInfinite))
	if (mine.tower === 0 && others.every((s) => s.tower === 0)) {
		const sum = others.reduce((acc, s) => acc + s.exact, 0n)
		const scaled = BigInt(others.length) * mine.exact
		return scaled === sum ? 0 : scaled > sum ? 1 : -1
	}
	const sumLog = log10Sum(others)
	const mineLog = log10Of(mine)
	if (sumLog !== null && Number.isFinite(mineLog))
		return sign(mineLog + Math.log10(others.length), sumLog)
	// at this magnitude the sum is the largest term
	return compare(mine, max(others))
}

// true when `mine` is strictly below the mean of `others`
export function isBelowMean(mine: Score, others: Score[]): boolean {
	return compareToMean(mine, others) < 0
}

// The smallest score that is not below the mean, so a client treating it as
// a ">=" target agrees with isBelowMean.
export function meanTarget(scores: Score[]): Score {
	if (scores.length === 0) return ZERO
	if (scores.some((s) => s.infinite)) return { ...ZERO, infinite: true }
	const n = BigInt(scores.length)
	if (scores.every((s) => s.tower === 0)) {
		const sum = scores.reduce((acc, s) => acc + s.exact, 0n)
		return { ...ZERO, exact: (sum + n - 1n) / n }
	}
	const sumLog = log10Sum(scores)
	if (sumLog === null) return max(scores)
	return {
		infinite: false,
		tower: 1,
		exact: 0n,
		towerValue: sumLog - Math.log10(scores.length),
	}
}

function luaNumber(x: number): string {
	// matches Lua's "%.14g", which is what the mod itself sends
	const s = x.toPrecision(14)
	if (!s.includes('e')) return s.includes('.') ? s.replace(/\.?0+$/, '') : s
	const [mant, exp] = s.split('e')
	const trimmed = mant.includes('.') ? mant.replace(/\.?0+$/, '') : mant
	const e = Number(exp)
	return `${trimmed}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(
		2,
		'0',
	)}`
}

export function formatScore(s: Score): string {
	if (s.infinite) return 'inf'
	if (s.tower > 0) return `${'e'.repeat(s.tower)}${luaNumber(s.towerValue)}`
	const str = s.exact.toString()
	if (str.length <= 15) return str
	return luaNumber(Number(`${str.slice(0, 16)}e${str.length - 16}`))
}
