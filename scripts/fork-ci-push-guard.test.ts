/**
 * Contract: `scripts/fork-ci-push-guard.ts` protects the fork's `.github/workflows/ci.yml`
 * against upstream merges that restore `on.push` triggers (branches or tags) or drop
 * `on.pull_request` on `main`.
 *
 * Failure modes defended:
 * - Upstream merge restores `on.push.branches: [main]` (or unfiltered `push:`), causing 12
 *   jobs to queue indefinitely on missing `vmon-large/from=omp-ci` runners.
 * - Upstream adds `tags` or `tags-ignore` under `on.push` or narrows `branches-ignore`,
 *   allowing tag or branch pushes to trigger `ci.yml`.
 * - `on.pull_request` is removed or drops `main`, breaking the fork's PR merge gate.
 * - Malformed YAML or bad CLI invocations exit 0 instead of failing loudly.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { validateForkCiWorkflow } from "./fork-ci-push-guard";

const GUARD_SCRIPT = path.resolve(import.meta.dir, "fork-ci-push-guard.ts");

describe("validateForkCiWorkflow", () => {
	it("accepts fork branches-ignore wildcard with preserved paths and pull_request on main", () => {
		const yaml = `
name: CI
on:
   push:
      branches-ignore: ["**"]
      paths:
         - "packages/**"
   pull_request:
      branches: [main, omp2]
`;
		expect(validateForkCiWorkflow(yaml)).toEqual({ ok: true, errors: [] });
	});

	it("accepts omitting on.push when pull_request targets main", () => {
		const yaml = `
name: CI
on:
   pull_request:
      branches: [main]
`;
		expect(validateForkCiWorkflow(yaml)).toEqual({ ok: true, errors: [] });
	});

	it("rejects upstream push-to-main and unfiltered push trigger forms", () => {
		const upstreamPush = validateForkCiWorkflow(`
on:
   push:
      branches: [main]
   pull_request:
      branches: [main, omp2]
`);
		expect(upstreamPush.ok).toBe(false);
		expect(upstreamPush.errors).toContain(
			'on.push.branches-ignore must be ["**"] so pushes to main never queue vmon jobs.',
		);
		expect(upstreamPush.errors).toContain("on.push must not define 'branches' in the fork.");

		const arrayOn = validateForkCiWorkflow("on: [push, pull_request]");
		expect(arrayOn.ok).toBe(false);
		expect(arrayOn.errors).toContain('on.push must be absent or a mapping with branches-ignore: ["**"].');

		const pushFalse = validateForkCiWorkflow(`
on:
   push: false
   pull_request:
      branches: [main]
`);
		expect(pushFalse.ok).toBe(false);
		expect(pushFalse.errors).toContain('on.push must be absent or a mapping with branches-ignore: ["**"].');
	});

	it("rejects tags, tags-ignore, or negated branches-ignore under on.push", () => {
		const withTags = validateForkCiWorkflow(`
on:
   push:
      branches-ignore: ["**"]
      tags: ["v*"]
   pull_request:
      branches: [main]
`);
		expect(withTags.ok).toBe(false);
		expect(withTags.errors).toContain("on.push must not define 'tags' in the fork.");

		const withTagsIgnore = validateForkCiWorkflow(`
on:
   push:
      branches-ignore: ["**"]
      tags-ignore: ["v1"]
   pull_request:
      branches: [main]
`);
		expect(withTagsIgnore.ok).toBe(false);
		expect(withTagsIgnore.errors).toContain("on.push must not define 'tags-ignore' in the fork.");

		const negatedIgnore = validateForkCiWorkflow(`
on:
   push:
      branches-ignore: ["**", "!main"]
   pull_request:
      branches: [main]
`);
		expect(negatedIgnore.ok).toBe(false);
		expect(negatedIgnore.errors).toContain(
			'on.push.branches-ignore must be ["**"] so pushes to main never queue vmon jobs.',
		);
	});

	it("rejects missing or non-main pull_request triggers", () => {
		const missingPr = validateForkCiWorkflow(`
on:
   push:
      branches-ignore: ["**"]
`);
		expect(missingPr.ok).toBe(false);
		expect(missingPr.errors).toContain("Workflow must define 'on.pull_request' targeting 'main'.");

		const wrongBranch = validateForkCiWorkflow(`
on:
   push:
      branches-ignore: ["**"]
   pull_request:
      branches: [omp2]
`);
		expect(wrongBranch.ok).toBe(false);
		expect(wrongBranch.errors).toContain("on.pull_request.branches must include 'main'.");
	});

	it("returns a parse error on malformed YAML", () => {
		const result = validateForkCiWorkflow("on: [push\njobs:\n  : bad");
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("Failed to parse workflow YAML:");
	});

	it("enforces CLI stdin, argument validation, and exit-code contracts", () => {
		const validYaml = `
on:
   push:
      branches-ignore: ["**"]
   pull_request:
      branches: [main]
`;
		const okRun = Bun.spawnSync(["bun", GUARD_SCRIPT, "-"], {
			stdin: new TextEncoder().encode(validYaml),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(okRun.exitCode).toBe(0);
		expect(okRun.stdout.toString()).toContain("<stdin> OK");

		const emptyArg = Bun.spawnSync(["bun", GUARD_SCRIPT, ""], { stdout: "pipe", stderr: "pipe" });
		expect(emptyArg.exitCode).toBe(1);
		expect(emptyArg.stderr.toString()).toContain("must not be empty");

		const extraArgs = Bun.spawnSync(["bun", GUARD_SCRIPT, "a.yml", "b.yml"], { stdout: "pipe", stderr: "pipe" });
		expect(extraArgs.exitCode).toBe(1);
		expect(extraArgs.stderr.toString()).toContain("usage:");
	});
});
