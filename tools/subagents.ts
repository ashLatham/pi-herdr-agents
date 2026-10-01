// Dynamic `delegate_<name>` tools, one per .json config in sub-agents/.
//
// Each JSON file declares the cwd + description for a thin wrapper around
// `runDelegate` (the extracted core of `herdr_delegate`). The wrapper takes
// a single `prompt` parameter and forwards it with the configured cwd.
//
// Cwd-scoped: a tool is only registered if its `cwd` matches the current
// agent's `process.cwd()`. Agents running elsewhere don't see these tools.
//
// Fail-soft: malformed JSONs, missing fields, or unreadable files are
// silently skipped. If no valid configs match, no tools are registered —
// the extension behaves as if `sub-agents/` were empty.

import os from "node:os";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runDelegate } from "./delegate.js";

interface SubAgentConfig {
	cwd: string;
	description: string;
}

/**
 * Read and parse one JSON config file. Returns null on any failure
 * (missing file, unreadable, invalid JSON, missing fields) — caller
 * treats null as "skip this file".
 */
function readConfig(filePath: string): SubAgentConfig | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.cwd !== "string" || obj.cwd.length === 0) return null;
	if (typeof obj.description !== "string" || obj.description.length === 0) return null;
	return { cwd: obj.cwd, description: obj.description };
}

/**
 * Register one dynamic `delegate_<name>` tool. Wraps `runDelegate` with
 * the configured cwd + description baked in; the LLM only sees `prompt`.
 */
function registerOne(
	pi: ExtensionAPI,
	toolName: string,
	cfg: SubAgentConfig,
): void {
	pi.registerTool({
		name: toolName,
		label: `Delegate to ${toolName} sub-agent`,
		description: cfg.description,
		promptSnippet: `One-shot delegate to ${cfg.cwd}`,
		promptGuidelines: [
			`Use ${toolName} when you need a fresh agent in ${cfg.cwd} to answer your prompt and return the result.`,
		],
		parameters: Type.Object({
			prompt: Type.String({
				description: "Prompt to send to the spawned sub-agent.",
			}),
		}),
		async execute(_id, p, signal) {
			return runDelegate({
				name: toolName,
				cwd: cfg.cwd,
				prompt: p.prompt,
				closeOnSuccess: false,
				onBlocked: "wait",
				signal,
			});
		},
		renderCall(args, theme) {
			const cwdShort = cfg.cwd?.startsWith(os.homedir())
				? "~" + cfg.cwd!.slice(os.homedir().length)
				: cfg.cwd;
			let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
			text += theme.fg("accent", toolName);
			text += theme.fg("dim", `\n  cwd: ${cwdShort}`);
			const shortPrompt = args.prompt?.length > 60 ? args.prompt!.slice(0, 60) + "…" : args.prompt;
			text += theme.fg("dim", `\n  prompt: "${shortPrompt}"`);
			return new Text(text, 0, 0);
		},
	});
}

/**
 * Locate the configs directory. Walks up from `import.meta.url`'s parent
 * looking for a sibling `sub-agents/` directory — handles whatever pi's
 * loader does to extension paths (we've seen it resolve to the parent
 * `extensions/` and to `herdr-agents/` in different builds).
 */
function locateConfigsDir(): string {
	const start = fileURLToPath(new URL(".", import.meta.url));
	let dir = start;
	for (let i = 0; i < 5; i++) {
		const candidate = pathJoin(dir, "sub-agents");
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* keep walking */
		}
		const parent = pathJoin(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return pathJoin(start, "..", "sub-agents"); // last-resort fallback
}

/**
 * Scan sub-agents/ for `*.json` configs and register `delegate_<basename>`
 * tools for each valid config.
 */
export function registerSubAgents(pi: ExtensionAPI): void {
	const dir = locateConfigsDir();

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// Directory missing or unreadable — no dynamic tools. Same as empty.
		return;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const baseName = entry.slice(0, -".json".length);
		if (!baseName) continue;

		const cfg = readConfig(pathJoin(dir, entry));
		if (!cfg) continue; // malformed — skip silently

		registerOne(pi, `delegate_${baseName}`, cfg);
	}
}
