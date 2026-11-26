/**
 * Contract: after the pooled CI runner finishes, a chunk that failed only on tests in
 * known files is retried once per file; it counts as passed only when every such file
 * passes and its junit report lists each failed test as passed, and each recovered test
 * is reported as a GitHub warning. A test that fails twice, a retry that does not run the
 * failed test, a crash, a kill, or a failure bun cannot pin to a test file (an import
 * error, an error between tests) keeps the chunk failed.
 *
 * If this regresses, either fork PRs stay red on upstream timing flakes, or a real
 * failure is hidden as a flake. Every first attempt here is a real `bun test` run with
 * the runner's argv layout, so the eligibility check reads bun's own output.
 */
import { afterEach, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FailedChunk, MAX_RETRY_FILES, type RetryableCommand, retryFailedTestFiles } from "./fork-ci-flake-retry";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Fixture copy of the runner's parser (`extractFailingTests` in ci-test-ts.ts, which runs
// its CLI on import): `file:` headers, then `(fail) name` markers.
function extractFailingTests(output: string): { name: string }[] {
	const failing: { name: string }[] = [];
	let file = "";
	for (const raw of output.split("\n")) {
		const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
		const header = /^(\S.*\.test\.[cm]?[jt]sx?):$/.exec(line);
		if (header) {
			file = header[1];
			continue;
		}
		const fail = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?$/.exec(line);
		if (fail) failing.push({ name: file ? `${file} > ${fail[1]}` : fail[1] });
	}
	return failing;
}

const FLAKY_NAME = "fails on its first run only (100%)";

const FAILS_ON_FIRST_RUN = `import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
describe("flaky suite", () => {
	test(${JSON.stringify(FLAKY_NAME)}, () => {
		const marker = \`\${process.env.FLAKE_DIR}/\${import.meta.file}.ran\`;
		const firstRun = !fs.existsSync(marker);
		fs.writeFileSync(marker, "");
		expect(firstRun).toBe(false);
	});
});
`;

const PASSES = `import { test } from "bun:test";
test("passes", () => {});
`;

const ALWAYS_FAILS = `import { expect, test } from "bun:test";
test("always fails", () => {
	expect(1).toBe(2);
});
`;

const THROWS_AT_IMPORT = `import { test } from "bun:test";
throw new Error("import failed");
test("never runs", () => {});
`;

const FAILS_THEN_CRASHES_WORKER = `import { expect, test } from "bun:test";
test("fails before the crash", () => {
	expect(1).toBe(2);
});
test("crashes the worker", () => {
	process.kill(process.pid, "SIGSEGV");
});
`;

const FAILS_THEN_EXITS_WORKER = `import { expect, test } from "bun:test";
test("fails before the exit", () => {
	expect(1).toBe(2);
});
test("exits the worker", () => {
	process.exit(1);
});
`;

const HOOK_FAILS_ON_FIRST_RUN = `import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
describe("server suite", () => {
	beforeAll(() => {
		const marker = \`\${process.env.FLAKE_DIR}/\${import.meta.file}.ran\`;
		const firstRun = !fs.existsSync(marker);
		fs.writeFileSync(marker, "");
		if (firstRun) throw new Error("server did not start in time");
	});
	test("answers", () => {
		expect(1).toBe(1);
	});
});
`;

interface Fixture {
	dir: string;
	env: Record<string, string | undefined>;
	command: RetryableCommand;
	failure: FailedChunk;
}

const PR_RUN = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" };

// Write `files` into `<dir>/pkg/test` and run them as one chunk with the runner's argv
// layout (test files, then the `--parallel`/`--timeout` the runner appends): the first attempt.
async function failedChunk(files: Record<string, string>): Promise<Fixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-flake-retry-"));
	tempDirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		await Bun.write(path.join(dir, "pkg", "test", name), content);
	}
	const env = { ...Bun.env, FLAKE_DIR: dir, GITHUB_ACTIONS: "" };
	const command: RetryableCommand = {
		label: "fixture chunk",
		cwd: "pkg",
		command: [
			"bun",
			"test",
			"--only-failures",
			...Object.keys(files).map(name => `test/${name}`),
			"--parallel=2",
			"--timeout=30000",
		],
	};
	const result = await $`${command.command}`.cwd(path.join(dir, "pkg")).env(env).quiet().nothrow();
	const failure = { label: command.label, exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
	return { dir, env, command, failure };
}

async function retry(fixture: Fixture, parentEnv: Record<string, string | undefined>) {
	const lines: string[] = [];
	const failures = [fixture.failure];
	const remaining = await retryFailedTestFiles({
		failures,
		commands: [fixture.command],
		env: fixture.env,
		repoRoot: fixture.dir,
		extractFailingTests,
		timeoutMs: 60_000,
		parentEnv,
		log: line => lines.push(line),
		childOutput: "ignore",
	});
	return { remaining, failures, log: lines.join("\n") };
}

test("a chunk whose failing file passes its one retry counts as passed and is annotated as flaky", async () => {
	const fixture = await failedChunk({ "flaky.test.ts": FAILS_ON_FIRST_RUN, "steady.test.ts": PASSES });
	expect(fixture.failure.exitCode).toBe(1);

	const { remaining, log } = await retry(fixture, PR_RUN);

	expect(remaining).toEqual([]);
	expect(log).toContain(
		"::warning title=Flaky test passed on retry::pkg/test/flaky.test.ts > flaky suite > fails on its first run only (100%25)",
	);
});

test("a test that fails on its retry too keeps the chunk failed", async () => {
	const fixture = await failedChunk({ "flaky.test.ts": FAILS_ON_FIRST_RUN, "broken.test.ts": ALWAYS_FAILS });

	const { remaining, failures, log } = await retry(fixture, PR_RUN);

	expect(remaining).toEqual(failures);
	expect(log).not.toContain("::warning title=Flaky test passed on retry::pkg/test/broken.test.ts");
});

test("a retry that exits 0 without running the failed test keeps the chunk failed", async () => {
	const fixture = await failedChunk({ "flaky.test.ts": FAILS_ON_FIRST_RUN });
	// The console named a test that the retried file does not hold, as a misattributed failure would.
	const marker = `(fail) flaky suite > ${FLAKY_NAME}`;
	expect(fixture.failure.output).toContain(marker);
	const output = fixture.failure.output.replace(marker, "(fail) flaky suite > a test in another file");
	const misattributed = { ...fixture, failure: { ...fixture.failure, output } };

	const { remaining, failures, log } = await retry(misattributed, PR_RUN);

	expect(remaining).toEqual(failures);
	expect(log).toContain(
		"its junit report does not list as passed: test/flaky.test.ts > flaky suite > a test in another file",
	);
	expect(log).not.toContain("::warning");
});

test("a flaky beforeAll hook recovers its chunk only when a test under it passes on retry", async () => {
	const fixture = await failedChunk({ "hook.test.ts": HOOK_FAILS_ON_FIRST_RUN });
	expect(fixture.failure.output).toContain("(fail) server suite > (unnamed)");

	const { remaining } = await retry(fixture, PR_RUN);
	expect(remaining).toEqual([]);

	// The same hook failure named under a describe that has no passing test stays unproven.
	const output = fixture.failure.output.replace("(fail) server suite > (unnamed)", "(fail) other suite > (unnamed)");
	const elsewhere = await retry({ ...fixture, failure: { ...fixture.failure, output } }, PR_RUN);
	expect(elsewhere.remaining).toEqual(elsewhere.failures);
	expect(elsewhere.log).toContain("exited 0 on retry, but its junit report does not list as passed");
});

test("failures bun cannot pin to one test in a test file are never retried", async () => {
	const importError = await failedChunk({
		"flaky.test.ts": FAILS_ON_FIRST_RUN,
		"import-error.test.ts": THROWS_AT_IMPORT,
	});
	const workerCrash = await failedChunk({ "crash.test.ts": FAILS_THEN_CRASHES_WORKER, "steady.test.ts": PASSES });
	const workerExit = await failedChunk({ "exit.test.ts": FAILS_THEN_EXITS_WORKER, "steady.test.ts": PASSES });
	const watchdogKill = await failedChunk({ "flaky.test.ts": FAILS_ON_FIRST_RUN });
	watchdogKill.failure = { ...watchdogKill.failure, exitCode: 137 };
	// Bun exits 1 and counts one failure for a crashed or exited worker, so only its crash notice tells it apart.
	expect(workerCrash.failure.exitCode).toBe(1);
	expect(workerExit.failure.exitCode).toBe(1);

	for (const fixture of [importError, workerCrash, workerExit, watchdogKill]) {
		const { remaining, failures, log } = await retry(fixture, PR_RUN);
		expect(remaining).toEqual(failures);
		expect(log).not.toContain("==> retry");
	}
}, 60_000);

test("a failure across more files than the limit is treated as breakage, not flakes", async () => {
	const files = Object.fromEntries(
		Array.from({ length: MAX_RETRY_FILES + 1 }, (_, index) => [`flaky-${index}.test.ts`, FAILS_ON_FIRST_RUN]),
	);
	const fixture = await failedChunk(files);

	const { remaining, failures, log } = await retry(fixture, PR_RUN);

	expect(remaining).toEqual(failures);
	expect(log).toContain(`exceed the retry limit of ${MAX_RETRY_FILES}`);
	expect(log).not.toContain("==> retry");
});

test("the retry is on for GitHub Actions pull_request runs only, unless OMP_TEST_RETRY_FAILED says otherwise", async () => {
	const fixture = await failedChunk({ "flaky.test.ts": FAILS_ON_FIRST_RUN });

	for (const parentEnv of [
		{},
		{ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" },
		{ ...PR_RUN, OMP_TEST_RETRY_FAILED: "0" },
	]) {
		const off = await retry(fixture, parentEnv);
		expect(off.remaining).toEqual(off.failures);
		expect(off.log).toBe("");
	}

	const on = await retry(fixture, { OMP_TEST_RETRY_FAILED: "1" });
	expect(on.remaining).toEqual([]);
	expect(on.log).not.toContain("::warning");
});
