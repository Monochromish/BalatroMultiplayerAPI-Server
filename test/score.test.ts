import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InsaneInt } from '../src/InsaneInt.js'
import {
	compare,
	compareToMean,
	formatScore,
	isBelowMean,
	meanTarget,
	parseScore,
} from '../src/score.js'

const p = parseScore

test('parses the formats the mod sends', () => {
	assert.equal(p('12345').exact, 12345n)
	assert.equal(p('0').exact, 0n)
	assert.equal(p('1.5e+3').exact, 1500n)
	assert.equal(p('1.2345678901234e+56').exact, 12345678901234n * 10n ** 43n)
	assert.equal(p('1,234').exact, 1234n)
	assert.equal(p('e1.5e12').tower, 1)
	assert.equal(p('e1.5e12').towerValue, 1.5e12)
	assert.equal(p('ee308').tower, 2)
	assert.equal(p('inf').infinite, true)
	assert.equal(p('nan').infinite, true)
	assert.equal(p('-nan(ind)').infinite, true)
	assert.equal(p(300).exact, 300n)
})

test('rejects garbage instead of guessing', () => {
	assert.throws(() => p('abc'), /unparseable score "abc"/)
	assert.throws(() => p(''), /unparseable/)
	assert.throws(() => p({}), /must be a string or number/)
})

test('orders scores across representations', () => {
	assert.equal(compare(p('100'), p('99')), 1)
	assert.equal(compare(p('100'), p('100')), 0)
	assert.equal(compare(p('1e+300'), p('e301')), -1)
	assert.equal(compare(p('e5000'), p('e4000')), 1)
	assert.equal(compare(p('ee10'), p('e1e300')), 1)
	assert.equal(compare(p('inf'), p('ee308')), 1)
	assert.equal(
		compare(
			p('123456789012345678901234567890'),
			p('123456789012345678901234567891'),
		),
		-1,
	)
})

test('two players: below the mean of the single opponent means strictly lower', () => {
	assert.equal(isBelowMean(p('100'), [p('200')]), true)
	assert.equal(isBelowMean(p('200'), [p('100')]), false)
	assert.equal(isBelowMean(p('150'), [p('150')]), false)
})

test('below mean of several opponents is exact for integers', () => {
	const others = [p('100'), p('201')]
	assert.equal(isBelowMean(p('150'), others), true)
	assert.equal(isBelowMean(p('151'), others), false)
	assert.equal(isBelowMean(p('150'), [p('100'), p('200')]), false)
	assert.equal(isBelowMean(p('0'), [p('0'), p('0')]), false)
})

test('beating the mean of opponents matches beating the mean of everyone', () => {
	const scores = [3n, 10n, 10n, 41n, 0n, 7n]
	for (let i = 0; i < scores.length; i++) {
		const others = scores.filter((_, j) => j !== i)
		const all = scores.reduce((a, b) => a + b, 0n)
		const belowAll = BigInt(scores.length) * scores[i] < all
		const others_ = others.map((v) => p(String(v)))
		assert.equal(
			isBelowMean(p(String(scores[i])), others_),
			belowAll,
			`player ${i}`,
		)
	}
})

test('below mean with towers falls back to magnitude', () => {
	assert.equal(isBelowMean(p('e100'), [p('e100'), p('e100')]), false)
	assert.equal(isBelowMean(p('e99'), [p('e100'), p('1')]), true)
	assert.equal(isBelowMean(p('ee10'), [p('e1e300'), p('ee11')]), true)
	assert.equal(isBelowMean(p('ee12'), [p('e1e300'), p('ee11')]), false)
	assert.equal(isBelowMean(p('inf'), [p('inf')]), false)
	assert.equal(isBelowMean(p('ee400'), [p('inf'), p('0')]), true)
})

test('meanTarget is the smallest integer not below the mean', () => {
	const scores = [p('100'), p('201')]
	const target = meanTarget(scores)
	assert.equal(target.exact, 151n)
	assert.equal(isBelowMean(target, scores), false)
	assert.equal(
		isBelowMean({ ...target, exact: target.exact - 1n }, scores),
		true,
	)
	assert.equal(meanTarget([p('300')]).exact, 300n)
	assert.equal(meanTarget([]).exact, 0n)
	assert.equal(meanTarget([p('e100'), p('e100')]).tower, 1)
	assert.ok(
		Math.abs(meanTarget([p('e100'), p('e100')]).towerValue - 100) < 1e-9,
	)
})

test("formats like Lua's tostring so the mod can parse it back", () => {
	assert.equal(formatScore(p('12345')), '12345')
	assert.equal(formatScore(p('123456789012345')), '123456789012345')
	assert.equal(formatScore(p('1e+20')), '1e+20')
	assert.equal(formatScore(p('1.2345678901234e+56')), '1.2345678901234e+56')
	assert.equal(formatScore(p('e1.5e12')), 'e1500000000000')
	assert.equal(formatScore(p('e1e+20')), 'e1e+20')
	assert.equal(formatScore(p('inf')), 'inf')
	for (const raw of ['7', '1e+20', '1.2345678901234e+56', 'e1e+20', 'ee308']) {
		assert.equal(compare(p(formatScore(p(raw))), p(raw)), 0, raw)
	}
})

test('compareToMean reports ties exactly', () => {
	assert.equal(compareToMean(p('150'), [p('100'), p('200')]), 0)
	assert.equal(compareToMean(p('151'), [p('100'), p('200')]), 1)
	assert.equal(compareToMean(p('149'), [p('100'), p('200')]), -1)
	assert.equal(compareToMean(p('5'), []), 1)
	assert.equal(compareToMean(p('inf'), [p('inf')]), 0)
	assert.equal(compareToMean(p('inf'), [p('9')]), 1)
	assert.equal(compareToMean(p('9'), [p('inf'), p('0')]), -1)
})

test('reads the server InsaneInt form of every score the mod sends', () => {
	for (const raw of ['0', '300', '1.2345678901234e+56', 'e1.2e5', 'ee308', '1e+20']) {
		const viaServer = p(InsaneInt.fromString(raw).toString())
		assert.equal(compare(viaServer, p(raw)), 0, raw)
	}
	assert.equal(p(InsaneInt.fromString('inf').toString()).infinite, true)
	assert.equal(p(InsaneInt.fromString('nan').toString()).infinite, true)
})
