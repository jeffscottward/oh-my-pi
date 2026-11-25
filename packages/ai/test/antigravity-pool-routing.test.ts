// Provider ranking contracts the Antigravity fleet fix depends on (card agy-fleet-fallback, 2026-11-25).
// Antigravity registers no usage provider, so the ranked candidates carry whatever the error-path estimator
// fills in (0 or 1) instead of real windows; the ranking must still keep its safety order: a blocked account
// last, and among unmeasured ones the cooler primary window first. The real fix lives in
// claude-quota-failover (`anti_models_from_pool` + `probe_model_only`), not here.
import { describe, expect, test } from "bun:test";
import { orderUsageRankedCandidates } from "../src/auth/rank";

type CandidateOptions = {
	accountPriority?: number;
	primaryUsed?: number;
	secondaryUsed?: number;
	usageMeasured?: boolean;
	blocked?: boolean;
};

/** One ranked candidate with the fields the comparator reads; defaults describe a measured, cool account. */
function candidate(index: number, o: CandidateOptions = {}) {
	return {
		selection: {
			credential: {
				type: "oauth",
				access: `token-${index}`,
				refresh: `refresh-${index}`,
				accountId: `acct-${index}`,
			},
			index,
		},
		usage: null,
		usageChecked: o.usageMeasured ?? true,
		blocked: o.blocked ?? false,
		blockedUntil: undefined,
		inReserve: false,
		reserveMeasured: false,
		allowanceSpent: false,
		usageMeasured: o.usageMeasured ?? true,
		hasPriorityBoost: false,
		planPriority: 0,
		accountPriority: o.accountPriority ?? 0,
		secondaryUsed: o.secondaryUsed ?? 0,
		secondaryRequiredDrain: 0,
		primaryUsed: o.primaryUsed ?? 0,
		primaryRequiredDrain: 0,
		orderPos: index,
	};
}

const chosen = (candidates: ReturnType<typeof candidate>[]): number => {
	const ordered = orderUsageRankedCandidates(candidates as never, false);
	return (ordered[0] as unknown as { selection: { index: number } }).selection.index;
};

describe("Account ranking used by the Antigravity fleet fix", () => {
	test("a cool account beats a near-spent one when neither has usage numbers", () => {
		expect(
			chosen([
				candidate(0, { primaryUsed: 1, secondaryUsed: 1 }),
				candidate(1, { primaryUsed: 0.5, secondaryUsed: 0.5 }),
			]),
		).toBe(1);
	});

	test("no numbers at all keeps the configured order", () => {
		expect(chosen([candidate(0), candidate(1)])).toBe(0);
	});

	test("a blocked account ranks behind an unblocked one", () => {
		expect(chosen([candidate(0, { blocked: true }), candidate(1, { primaryUsed: 1, secondaryUsed: 1 })])).toBe(1);
	});
});
