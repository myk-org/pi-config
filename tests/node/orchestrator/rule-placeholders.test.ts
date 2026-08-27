/**
 * Placeholder substitution and conditional rule assembly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	substituteRulePlaceholders,
	substituteSettingsPlaceholders,
	isSettingTruthy,
	parseConditionExpr,
	evaluateConditionalBlocks,
	parseRuleFrontmatter,
	rulePassesFrontmatterGate,
	assembleRuleText,
} from "../../../extensions/orchestrator/rule-placeholders.js";

describe("substituteRulePlaceholders", () => {
	it("replaces a single placeholder occurrence", () => {
		const result = substituteRulePlaceholders("Max cycles: {{REVIEW_LOOP_MAX_CYCLES}}", { reviewLoopMaxCycles: 3 });
		assert.equal(result, "Max cycles: 3");
	});

	it("replaces all occurrences", () => {
		const text = "{{REVIEW_LOOP_MAX_CYCLES}} cycles max. Stop after {{REVIEW_LOOP_MAX_CYCLES}} cycles.";
		const result = substituteRulePlaceholders(text, { reviewLoopMaxCycles: 5 });
		assert.equal(result, "5 cycles max. Stop after 5 cycles.");
	});

	it("supports boundary numeric values", () => {
		assert.equal(
			substituteRulePlaceholders("{{REVIEW_LOOP_MAX_CYCLES}}", { reviewLoopMaxCycles: 1 }),
			"1",
		);
		assert.equal(
			substituteRulePlaceholders("{{REVIEW_LOOP_MAX_CYCLES}}", { reviewLoopMaxCycles: 10 }),
			"10",
		);
	});

	it("leaves text unchanged when placeholder is absent", () => {
		const result = substituteRulePlaceholders("No placeholders here.", { reviewLoopMaxCycles: 3 });
		assert.equal(result, "No placeholders here.");
	});
});

describe("substituteSettingsPlaceholders", () => {
	const resolve = (key: string): unknown => {
		const values: Record<string, unknown> = {
			dco: true,
			commit_trailer: "Assisted-by",
			use_worktrees: false,
			comment_signature: true,
		};
		return values[key] ?? false;
	};
	const allKeys = ["dco", "commit_trailer", "use_worktrees", "comment_signature"];

	it("replaces {{SETTINGS:key1,key2}} with resolved JSON", () => {
		const result = substituteSettingsPlaceholders("Config: {{SETTINGS:dco,commit_trailer}}", resolve, allKeys);
		assert.equal(result, 'Config: {"dco":true,"commit_trailer":"Assisted-by"}');
	});

	it("replaces {{SETTINGS}} (no keys) with all keys", () => {
		const result = substituteSettingsPlaceholders("All: {{SETTINGS}}", resolve, allKeys);
		assert.equal(result, 'All: {"dco":true,"commit_trailer":"Assisted-by","use_worktrees":false,"comment_signature":true}');
	});

	it("handles multiple placeholders", () => {
		const text = "A: {{SETTINGS:dco}} B: {{SETTINGS:commit_trailer,use_worktrees}}";
		const result = substituteSettingsPlaceholders(text, resolve, allKeys);
		assert.equal(result, 'A: {"dco":true} B: {"commit_trailer":"Assisted-by","use_worktrees":false}');
	});

	it("leaves text unchanged when no placeholders", () => {
		const result = substituteSettingsPlaceholders("No placeholders here.", resolve, allKeys);
		assert.equal(result, "No placeholders here.");
	});

	it("skips unknown keys", () => {
		const result = substituteSettingsPlaceholders("{{SETTINGS:unknown_key}}", resolve, allKeys);
		assert.equal(result, '{}');
	});

	it("skips unknown keys but keeps valid ones", () => {
		const result = substituteSettingsPlaceholders("{{SETTINGS:dco,bad_key,commit_trailer}}", resolve, allKeys);
		assert.equal(result, '{"dco":true,"commit_trailer":"Assisted-by"}');
	});
});

describe("isSettingTruthy", () => {
	it("treats false/null/undefined/empty/0 as falsy", () => {
		assert.equal(isSettingTruthy(false), false);
		assert.equal(isSettingTruthy(null), false);
		assert.equal(isSettingTruthy(undefined), false);
		assert.equal(isSettingTruthy(""), false);
		assert.equal(isSettingTruthy(0), false);
	});

	it("treats empty array as falsy", () => {
		assert.equal(isSettingTruthy([]), false);
	});

	it("treats empty object as falsy", () => {
		assert.equal(isSettingTruthy({}), false);
	});

	it("treats true/nonempty string/array/nonzero number as truthy", () => {
		assert.equal(isSettingTruthy(true), true);
		assert.equal(isSettingTruthy("yes"), true);
		assert.equal(isSettingTruthy("false"), true); // non-empty string
		assert.equal(isSettingTruthy([1]), true);
		assert.equal(isSettingTruthy(1), true);
		assert.equal(isSettingTruthy(-1), true);
		assert.equal(isSettingTruthy({ a: 1 }), true);
	});
});

describe("parseConditionExpr", () => {
	it("parses truthy key-only", () => {
		assert.deepEqual(parseConditionExpr("review_loop_enforcement"), {
			key: "review_loop_enforcement",
			op: "truthy",
		});
	});

	it("parses == with literals", () => {
		assert.deepEqual(parseConditionExpr("mode==strict"), {
			key: "mode",
			op: "eq",
			literal: "strict",
		});
		assert.deepEqual(parseConditionExpr("count==3"), {
			key: "count",
			op: "eq",
			literal: 3,
		});
		assert.deepEqual(parseConditionExpr("flag==true"), {
			key: "flag",
			op: "eq",
			literal: true,
		});
	});

	it("parses != with literals", () => {
		assert.deepEqual(parseConditionExpr('mode != "off"'), {
			key: "mode",
			op: "neq",
			literal: "off",
		});
	});

	it("returns null for malformed", () => {
		assert.equal(parseConditionExpr(""), null);
		assert.equal(parseConditionExpr("1bad"), null);
		assert.equal(parseConditionExpr("a b"), null);
	});
});

describe("evaluateConditionalBlocks", () => {
	const knownKeys = ["review_loop_enforcement", "mode", "count"];

	it("includes IF body when setting is truthy", () => {
		const text = "before {{IF:review_loop_enforcement}}INNER{{/IF}} after";
		const result = evaluateConditionalBlocks(text, () => true, { knownKeys });
		assert.equal(result, "before INNER after");
	});

	it("strips IF body when setting is falsy", () => {
		const text = "before {{IF:review_loop_enforcement}}INNER{{/IF}} after";
		const result = evaluateConditionalBlocks(text, () => false, { knownKeys });
		assert.equal(result, "before  after");
	});

	it("includes IFNOT body when setting is falsy", () => {
		const text = "{{IFNOT:review_loop_enforcement}}off{{/IFNOT}}";
		const result = evaluateConditionalBlocks(text, () => false, { knownKeys });
		assert.equal(result, "off");
	});

	it("strips IFNOT body when setting is truthy", () => {
		const text = "{{IFNOT:review_loop_enforcement}}off{{/IFNOT}}";
		const result = evaluateConditionalBlocks(text, () => true, { knownKeys });
		assert.equal(result, "");
	});

	it("supports == comparisons", () => {
		const resolve = (key: string) => (key === "mode" ? "strict" : undefined);
		assert.equal(
			evaluateConditionalBlocks("{{IF:mode==strict}}yes{{/IF}}", resolve, { knownKeys }),
			"yes",
		);
		assert.equal(
			evaluateConditionalBlocks("{{IF:mode==loose}}yes{{/IF}}", resolve, { knownKeys }),
			"",
		);
	});

	it("supports != comparisons", () => {
		const resolve = (key: string) => (key === "mode" ? "strict" : undefined);
		assert.equal(
			evaluateConditionalBlocks("{{IF:mode!=loose}}yes{{/IF}}", resolve, { knownKeys }),
			"yes",
		);
		assert.equal(
			evaluateConditionalBlocks("{{IF:mode!=strict}}yes{{/IF}}", resolve, { knownKeys }),
			"",
		);
	});

	it("supports nesting", () => {
		const resolve = (key: string) => {
			if (key === "review_loop_enforcement") return true;
			if (key === "mode") return "strict";
			return undefined;
		};
		const text =
			"{{IF:review_loop_enforcement}}outer {{IF:mode==strict}}inner{{/IF}} end{{/IF}}";
		assert.equal(evaluateConditionalBlocks(text, resolve, { knownKeys }), "outer inner end");
		const resolveLoose = (key: string) => {
			if (key === "review_loop_enforcement") return true;
			if (key === "mode") return "loose";
			return undefined;
		};
		assert.equal(evaluateConditionalBlocks(text, resolveLoose, { knownKeys }), "outer  end");
	});

	it("treats unknown IF key as falsy with warning", () => {
		const warnings: string[] = [];
		const text = "{{IF:unknown_key}}secret{{/IF}}keep";
		const result = evaluateConditionalBlocks(text, () => true, {
			knownKeys,
			onWarn: (msg) => warnings.push(msg),
		});
		assert.equal(result, "keep");
		assert.ok(warnings.some((w) => w.includes("unknown_key")));
	});

	it("strips IFNOT body for unknown key with warning", () => {
		const warnings: string[] = [];
		const result = evaluateConditionalBlocks("{{IFNOT:typo}}X{{/IFNOT}}", () => true, {
			knownKeys,
			onWarn: (msg) => warnings.push(msg),
		});
		assert.equal(result, "");
		assert.ok(warnings.some((w) => w.includes("typo")));
	});

	it("leaves unbalanced markers as-is, warns, does not throw", () => {
		const warnings: string[] = [];
		const openOnly = "start {{IF:mode}}body";
		assert.equal(
			evaluateConditionalBlocks(openOnly, () => true, {
				knownKeys,
				onWarn: (msg) => warnings.push(msg),
			}),
			openOnly,
		);
		assert.ok(warnings.some((w) => w.includes("unbalanced")));

		warnings.length = 0;
		const strayClose = "a {{/IF}} b";
		assert.equal(
			evaluateConditionalBlocks(strayClose, () => true, {
				knownKeys,
				onWarn: (msg) => warnings.push(msg),
			}),
			strayClose,
		);
		assert.ok(warnings.some((w) => w.includes("unbalanced")));
	});

	it("leaves default/no-marker text unchanged", () => {
		const text = "plain rules with no markers";
		assert.equal(evaluateConditionalBlocks(text, () => true, { knownKeys }), text);
	});

	it("nested IF/IFNOT mismatch: warn, leave as-is (kind stack)", () => {
		const warnings: string[] = [];
		// Outer IF closed by /IFNOT — mismatched closer must not pop
		const text = "{{IF:mode}}outer {{IFNOT:count}}inner{{/IF}} end{{/IFNOT}}";
		const result = evaluateConditionalBlocks(text, () => true, {
			knownKeys,
			onWarn: (msg) => warnings.push(msg),
		});
		assert.equal(result, text);
		assert.ok(warnings.some((w) => w.includes("unbalanced")));
	});

	it("featurePredicates consulted for truthy IF when key is a feature", () => {
		const text = "{{IF:external_ai_agents}}ROW{{/IF}}keep";
		assert.equal(
			evaluateConditionalBlocks(text, () => false, {
				knownKeys,
				featurePredicates: { external_ai_agents: () => true },
			}),
			"ROWkeep",
		);
		assert.equal(
			evaluateConditionalBlocks(text, () => true, {
				knownKeys,
				featurePredicates: { external_ai_agents: () => false },
			}),
			"keep",
		);
	});

	it("collapses blank lines between table rows after removing IF", () => {
		const text = [
			"| a | b |",
			"|---|---|",
			"| keep | 1 |",
			"{{IF:mode}}",
			"| gated | 2 |",
			"{{/IF}}",
			"| after | 3 |",
		].join("\n");
		const result = evaluateConditionalBlocks(text, () => false, { knownKeys });
		assert.doesNotMatch(result, /\{\{IF/);
		assert.doesNotMatch(result, /gated/);
		// Consecutive table rows must be adjacent (no blank line between | rows)
		assert.doesNotMatch(result, /\|\n\n\|/);
		assert.match(result, /\| keep \| 1 \|\n\| after \| 3 \|/);
	});
});

describe("parseRuleFrontmatter", () => {
	it("returns empty attrs plus raw body when no frontmatter", () => {
		const raw = "# Rule\n\ncontent";
		assert.deepEqual(parseRuleFrontmatter(raw), { attrs: {}, body: raw });
	});

	it("parses key: value attrs plus body", () => {
		const raw = "---\nrequires_setting: review_loop_enforcement\nrequires: coms_active\n---\n# Body\n";
		const { attrs, body } = parseRuleFrontmatter(raw);
		assert.deepEqual(attrs, {
			requires_setting: "review_loop_enforcement",
			requires: "coms_active",
		});
		assert.equal(body, "# Body\n");
	});
});

describe("rulePassesFrontmatterGate", () => {
	const knownKeys = ["review_loop_enforcement", "dco"];

	it("passes when no requires attrs", () => {
		assert.equal(
			rulePassesFrontmatterGate({}, {
				resolveSetting: () => false,
				featurePredicates: {},
				knownKeys,
			}),
			true,
		);
	});

	it("requires_setting must be truthy", () => {
		assert.equal(
			rulePassesFrontmatterGate({ requires_setting: "review_loop_enforcement" }, {
				resolveSetting: (k) => k === "review_loop_enforcement",
				featurePredicates: {},
				knownKeys,
			}),
			true,
		);
		assert.equal(
			rulePassesFrontmatterGate({ requires_setting: "review_loop_enforcement" }, {
				resolveSetting: () => false,
				featurePredicates: {},
				knownKeys,
			}),
			false,
		);
	});

	it("requires feature predicate must return true", () => {
		assert.equal(
			rulePassesFrontmatterGate({ requires: "coms_active" }, {
				resolveSetting: () => true,
				featurePredicates: { coms_active: () => true },
				knownKeys,
			}),
			true,
		);
		assert.equal(
			rulePassesFrontmatterGate({ requires: "coms_active" }, {
				resolveSetting: () => true,
				featurePredicates: { coms_active: () => false },
				knownKeys,
			}),
			false,
		);
	});

	it("ANDs requires_setting with requires when both present", () => {
		const attrs = { requires_setting: "dco", requires: "coms_active" };
		assert.equal(
			rulePassesFrontmatterGate(attrs, {
				resolveSetting: () => true,
				featurePredicates: { coms_active: () => true },
				knownKeys,
			}),
			true,
		);
		assert.equal(
			rulePassesFrontmatterGate(attrs, {
				resolveSetting: () => true,
				featurePredicates: { coms_active: () => false },
				knownKeys,
			}),
			false,
		);
		assert.equal(
			rulePassesFrontmatterGate(attrs, {
				resolveSetting: () => false,
				featurePredicates: { coms_active: () => true },
				knownKeys,
			}),
			false,
		);
	});

	it("warns, fails on unknown requires_setting / feature", () => {
		const warnings: string[] = [];
		assert.equal(
			rulePassesFrontmatterGate({ requires_setting: "nope" }, {
				resolveSetting: () => true,
				featurePredicates: {},
				knownKeys,
				onWarn: (m) => warnings.push(m),
			}),
			false,
		);
		assert.ok(warnings.some((w) => w.includes("unknown requires_setting")));

		warnings.length = 0;
		assert.equal(
			rulePassesFrontmatterGate({ requires: "missing_feat" }, {
				resolveSetting: () => true,
				featurePredicates: {},
				knownKeys,
				onWarn: (m) => warnings.push(m),
			}),
			false,
		);
		assert.ok(warnings.some((w) => w.includes("unknown feature")));
	});

	it("warns, fails when feature predicate throws", () => {
		const warnings: string[] = [];
		assert.equal(
			rulePassesFrontmatterGate({ requires: "boom" }, {
				resolveSetting: () => true,
				featurePredicates: {
					boom: () => {
						throw new Error("pred failed");
					},
				},
				knownKeys,
				onWarn: (m) => warnings.push(m),
			}),
			false,
		);
		assert.ok(warnings.some((w) => w.includes("feature predicate boom threw")));
	});
});

describe("assembleRuleText", () => {
	const knownKeys = ["review_loop_enforcement", "dco"];

	function baseOpts(overrides: Partial<{
		resolve: (key: string) => unknown;
		featurePredicates: Record<string, () => boolean>;
		reviewLoopMaxCycles: number;
		onWarn: (msg: string) => void;
		onSkip: (info: { attrs: Record<string, string>; index: number }) => void;
		onInclude: (info: { attrs: Record<string, string>; index: number }) => void;
	}> = {}) {
		return {
			resolve: (key: string) => (key === "review_loop_enforcement" ? true : false),
			knownKeys,
			featurePredicates: { coms_active: () => false },
			reviewLoopMaxCycles: 3,
			...overrides,
		};
	}

	it("includes IF block when setting on, strips when off", () => {
		const contents = [
			"always\n{{IF:review_loop_enforcement}}gated{{/IF}}\n",
		];
		const on = assembleRuleText(contents, baseOpts({ resolve: () => true }));
		assert.match(on, /always/);
		assert.match(on, /gated/);

		const off = assembleRuleText(contents, baseOpts({ resolve: () => false }));
		assert.match(off, /always/);
		assert.doesNotMatch(off, /gated/);
	});

	it("skips whole file via frontmatter gate, calls onSkip", () => {
		const skipped: number[] = [];
		const included: number[] = [];
		const contents = [
			"---\nrequires_setting: review_loop_enforcement\n---\n# Gated\n",
			"# Always\n",
		];
		const result = assembleRuleText(contents, baseOpts({
			resolve: () => false,
			onSkip: ({ index }) => skipped.push(index),
			onInclude: ({ index }) => included.push(index),
		}));
		assert.equal(skipped.length, 1);
		assert.equal(skipped[0], 0);
		assert.deepEqual(included, [1]);
		assert.match(result, /Always/);
		assert.doesNotMatch(result, /Gated/);
	});

	it("substitutes {{REVIEW_LOOP_MAX_CYCLES}} after conditionals", () => {
		const contents = [
			"{{IF:review_loop_enforcement}}max={{REVIEW_LOOP_MAX_CYCLES}}{{/IF}}",
		];
		const result = assembleRuleText(contents, baseOpts({
			resolve: () => true,
			reviewLoopMaxCycles: 7,
		}));
		assert.equal(result, "max=7");
	});

	it("leaves default/no-marker text unchanged aside from join", () => {
		const contents = ["rule a", "rule b"];
		const result = assembleRuleText(contents, baseOpts());
		assert.equal(result, "rule a\n\nrule b");
	});

	it("shortens output when review_loop_enforcement is false (token/line budget)", () => {
		const sample = [
			"# Base rules\nKeep short.\n",
			[
				"{{IF:review_loop_enforcement}}",
				"## Review Loop (enforced)",
				"When review_loop_enforcement is enabled, run all 6 agents.",
				"Max cycles: {{REVIEW_LOOP_MAX_CYCLES}}",
				"Respond to findings, re-run reviewers, stop at cap.",
				"This block is intentionally long so gated-off assembly is shorter.",
				"Line A with review loop details and enforcement wording.",
				"Line B with more review loop details and enforcement wording.",
				"Line C with even more review loop details and enforcement wording.",
				"{{/IF}}",
			].join("\n"),
		];
		const on = assembleRuleText(sample, baseOpts({
			resolve: (k) => (k === "review_loop_enforcement" ? true : false),
			reviewLoopMaxCycles: 3,
		}));
		const off = assembleRuleText(sample, baseOpts({
			resolve: () => false,
			reviewLoopMaxCycles: 3,
		}));
		assert.ok(off.length < on.length, `off (${off.length}) should be shorter than on (${on.length})`);
		assert.ok(off.split("\n").length < on.split("\n").length);
		assert.match(on, /Review Loop/);
		assert.doesNotMatch(off, /Review Loop/);
		assert.match(on, /max cycles: 3/i);
	});

	it("assembles the code review rule without mandatory dispatch when enforcement is disabled", async () => {
		const { readFileSync } = await import("node:fs");
		const { join, dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
		const reviewLoop = readFileSync(join(root, "rules/20-code-review-loop.md"), "utf-8");
		const off = assembleRuleText(["# Unrelated rule\nKeep this content.", reviewLoop], baseOpts({ resolve: () => false }));

		assert.match(off, /Keep this content/);
		assert.match(off, /Manual code reviews and test runs are optional/);
		assert.match(off, /No review state, cycle, or result is required before git commit/);
		assert.doesNotMatch(off, /Send ALL 6 agents IN PARALLEL/);
		assert.doesNotMatch(off, /All 6 MUST be invoked/);
		assert.doesNotMatch(off, /Never skip code review/);
		assert.doesNotMatch(off, /test-automator/);
	});

	it("assembles the complete enforced review workflow without changing unrelated content", async () => {
		const { readFileSync } = await import("node:fs");
		const { join, dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
		const reviewLoop = readFileSync(join(root, "rules/20-code-review-loop.md"), "utf-8");
		const on = assembleRuleText(["# Unrelated rule\nKeep this content.", reviewLoop], baseOpts({
			resolve: (key) => key === "review_loop_enforcement",
			reviewLoopMaxCycles: 3,
		}));

		assert.match(on, /Keep this content/);
		assert.match(on, /Send ALL 6 agents IN PARALLEL/);
		assert.match(on, /All 6 MUST be invoked/);
		assert.match(on, /MUST loop until clean or the max cycle cap is reached/);
		assert.match(on, /tests_passed: true/);
		assert.match(on, /Baseline Test Comparison/);
		assert.match(on, /Staged Review Mode/);
	});

	it("does not cross-file match IF open/close (per-body evaluation)", () => {
		const warnings: string[] = [];
		const contents = [
			"# File A\n{{IF:review_loop_enforcement}}\ngated-a\n",
			"# Middle package rule — must NOT be stripped\nmiddle-keep\n",
			"gated-b\n{{/IF}}\n# File C\n",
		];
		const result = assembleRuleText(contents, baseOpts({
			resolve: () => false,
			onWarn: (msg) => warnings.push(msg),
		}));
		// Unbalanced in each file → leave as-is / warn; middle content preserved
		assert.match(result, /middle-keep/);
		assert.match(result, /File A/);
		assert.ok(warnings.some((w) => w.includes("unbalanced")));
	});

	it("loads real migrated rule fixtures: enforcement off shorter; no leftover IF; table rows adjacent", async () => {
		const { readFileSync } = await import("node:fs");
		const { join, dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
		const reviewLoop = readFileSync(join(root, "rules/20-code-review-loop.md"), "utf-8");
		const routing = readFileSync(join(root, "rules/10-agent-routing.md"), "utf-8");

		const featureOn = {
			coms_active: () => false,
			external_ai_agents: () => true,
		};
		const featureOff = {
			coms_active: () => false,
			external_ai_agents: () => false,
		};

		const on = assembleRuleText([reviewLoop], baseOpts({
			resolve: (k) => (k === "review_loop_enforcement" ? true : false),
			featurePredicates: featureOn,
			reviewLoopMaxCycles: 3,
		}));
		const off = assembleRuleText([reviewLoop], baseOpts({
			resolve: () => false,
			featurePredicates: featureOff,
			reviewLoopMaxCycles: 3,
		}));
		assert.ok(off.length < on.length, `enforcement off (${off.length}) should be shorter than on (${on.length})`);
		assert.doesNotMatch(on, /\{\{IF/);
		assert.doesNotMatch(off, /\{\{IF/);
		assert.doesNotMatch(on, /\{\{\/IF/);
		assert.doesNotMatch(off, /\{\{\/IF/);

		const routingOn = assembleRuleText([routing], baseOpts({
			resolve: () => false,
			featurePredicates: featureOn,
		}));
		const routingOff = assembleRuleText([routing], baseOpts({
			resolve: () => false,
			featurePredicates: featureOff,
		}));
		assert.doesNotMatch(routingOn, /\{\{IF/);
		assert.doesNotMatch(routingOff, /\{\{IF/);
		assert.match(routingOn, /External AI agents/);
		assert.doesNotMatch(routingOff, /External AI agents/);
		// No blank line between consecutive table rows
		assert.doesNotMatch(routingOn, /\|\n\n\|/);
		assert.doesNotMatch(routingOff, /\|\n\n\|/);
	});
});
