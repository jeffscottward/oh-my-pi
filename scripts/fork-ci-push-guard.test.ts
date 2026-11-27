import { describe, expect, it } from "bun:test";
import { validateForkCiWorkflow } from "./fork-ci-push-guard";

const UPSTREAM_JOBS = `
jobs:
   release_metadata:
      runs-on: ubuntu-22.04
   check:
      runs-on: \${{ github.event_name == 'pull_request' && 'ubuntu-22.04' || 'vmon-large/from=omp-ci' }}
   rust_validate:
      if: github.event_name != 'pull_request'
      runs-on: vmon-large/from=omp-ci
   release_smoke:
      if: \${{ needs.release_metadata.outputs.is-release == 'true' && !cancelled() }}
      strategy:
         matrix:
            include:
               - os: ubuntu-22.04
               - os: macos-15
               - os: windows-2025
      runs-on: \${{ matrix.os }}
`;

describe("validateForkCiWorkflow", () => {
	it("rejects upstream push-to-main trigger when push-reachable jobs use vmon runners", () => {
		const yaml = `
name: CI
on:
   push:
      branches: [main]
   pull_request:
      branches: [main, omp2]
${UPSTREAM_JOBS}
`;
		const result = validateForkCiWorkflow(yaml);
		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			"Job 'check' (push) resolves 'runs-on' to non-hosted runner 'vmon-large/from=omp-ci'.",
		);
		expect(result.errors).toContain("Job 'rust_validate' (push) uses non-hosted runner 'vmon-large/from=omp-ci'.");
	});

	it("accepts fork branches-ignore wildcard while preserving pull_request hosted jobs", () => {
		const yaml = `
name: CI
on:
   push:
      branches-ignore: ["**"]
      paths:
         - "packages/**"
   pull_request:
      branches: [main, omp2]
${UPSTREAM_JOBS}
`;
		const result = validateForkCiWorkflow(yaml);
		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("accepts omitting on.push when pull_request targets main with hosted runners", () => {
		const yaml = `
name: CI
on:
   pull_request:
      branches: [main]
${UPSTREAM_JOBS}
`;
		const result = validateForkCiWorkflow(yaml);
		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("accepts on.push to main when every push-reachable job (including matrix.os) is GitHub-hosted", () => {
		const yaml = `
name: CI
on:
   push:
      branches: [main]
   pull_request:
      branches: [main]
jobs:
   check:
      runs-on: ubuntu-22.04
   release_smoke:
      if: \${{ needs.release_metadata.outputs.is-release == 'true' }}
      strategy:
         matrix:
            include:
               - os: ubuntu-22.04
               - os: ubuntu-24.04-arm
               - os: macos-15
               - os: windows-2025
      runs-on: \${{ matrix.os }}
`;
		const result = validateForkCiWorkflow(yaml);
		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("rejects unfiltered push forms (null mapping, array on, string on) with non-hosted jobs", () => {
		const nullPush = `
on:
   push:
   pull_request:
      branches: [main]
${UPSTREAM_JOBS}
`;
		expect(validateForkCiWorkflow(nullPush).ok).toBe(false);

		const arrayOn = `
on: [push, pull_request]
${UPSTREAM_JOBS}
`;
		expect(validateForkCiWorkflow(arrayOn).ok).toBe(false);

		const stringOn = `
on: push
${UPSTREAM_JOBS}
`;
		const stringResult = validateForkCiWorkflow(stringOn);
		expect(stringResult.ok).toBe(false);
		expect(stringResult.errors).toContain("Workflow must define 'on.pull_request' targeting 'main'.");
	});

	it("honors ordered ! negation in branches-ignore and branches", () => {
		const unignoredMain = `
on:
   push:
      branches-ignore: ["**", "!main"]
   pull_request:
      branches: [main]
${UPSTREAM_JOBS}
`;
		expect(validateForkCiWorkflow(unignoredMain).ok).toBe(false);

		const excludedMain = `
on:
   push:
      branches: ["*", "!main"]
   pull_request:
      branches: [main]
${UPSTREAM_JOBS}
`;
		expect(validateForkCiWorkflow(excludedMain)).toEqual({ ok: true, errors: [] });
	});

	it("rejects on.push tag triggers when non-hosted jobs would run on tag push", () => {
		const yaml = `
on:
   push:
      branches-ignore: ["**"]
      tags: ["v*"]
   pull_request:
      branches: [main]
${UPSTREAM_JOBS}
`;
		const result = validateForkCiWorkflow(yaml);
		expect(result.ok).toBe(false);
		expect(result.errors.some(e => e.includes("vmon-large/from=omp-ci"))).toBe(true);
	});

	it("rejects mutually exclusive branch or tag filters", () => {
		const yaml = `
on:
   push:
      branches: [main]
      branches-ignore: ["**"]
   pull_request:
      branches: [main]
jobs:
   check:
      runs-on: ubuntu-22.04
`;
		const result = validateForkCiWorkflow(yaml);
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("on.push cannot specify both 'branches' and 'branches-ignore'.");
	});

	it("rejects missing or non-main pull_request trigger", () => {
		const missingPr = `
on:
   push:
      branches-ignore: ["**"]
jobs:
   check:
      runs-on: ubuntu-22.04
`;
		expect(validateForkCiWorkflow(missingPr).ok).toBe(false);

		const wrongBranch = `
on:
   push:
      branches-ignore: ["**"]
   pull_request:
      branches: [omp2]
jobs:
   check:
      runs-on: ubuntu-22.04
`;
		const result = validateForkCiWorkflow(wrongBranch);
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("Workflow 'on.pull_request' must match branch 'main'.");
	});

	it("fails closed on non-hosted labels, runner arrays, or unrecognized runs-on expressions on pull_request", () => {
		const yaml = `
on:
   push:
      branches-ignore: ["**"]
   pull_request:
      branches: [main]
jobs:
   self_hosted_array:
      runs-on: [self-hosted, linux]
   unknown_expr:
      runs-on: \${{ vars.CUSTOM_RUNNER }}
   bad_matrix:
      strategy:
         matrix:
            include:
               - os: vmon-large/from=omp-ci
      runs-on: \${{ matrix.os }}
`;
		const result = validateForkCiWorkflow(yaml);
		expect(result.ok).toBe(false);
		expect(result.errors.some(e => e.includes("self_hosted_array"))).toBe(true);
		expect(result.errors.some(e => e.includes("unknown_expr"))).toBe(true);
		expect(result.errors.some(e => e.includes("bad_matrix"))).toBe(true);
	});

	it("returns a parse error on malformed YAML", () => {
		const result = validateForkCiWorkflow("on: [push\njobs:\n  : bad");
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("Failed to parse workflow YAML:");
	});
});
