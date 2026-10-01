// Cascade primitives used by `herdr_new_agent` and `herdr_delegate`.
//
// `safeName` and `resolveHome` are pure string helpers.
// `ensureWorkspaceTabAgent` is the workspace → tab → agent cascade.
// `resolvePaneId` translates a flexible target (paneId/agent name/label)
// into a concrete pane id by calling `agent get`.

import os from "node:os";
import { join as pathJoin } from "node:path";
import { herdr } from "../herdr.js";
import { err, type Err, type Result, type ToolReturn } from "../env.js";

/** Build an error ToolReturn from a non-ok Result. */
export function fail(r: Err): ToolReturn {
	return {
		content: [
			{ type: "text", text: `Error (${r.error.code}): ${r.error.message}` },
		],
		details: { error: r.error },
		isError: true,
	};
}

/** Build a success ToolReturn with custom text + structured details. */
export function okText(text: string, details: unknown): ToolReturn {
	return { content: [{ type: "text", text }], details };
}

/** Sanitize a name to safe filename chars. */
export function safeName(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Expand a leading ~/ into an absolute path. */
export function resolveHome(p: string): string {
	if (p.startsWith("~/")) {
		return pathJoin(os.homedir(), p.slice(2));
	}
	return p;
}

export interface CascadeResult {
	paneId: string;
	workspaceId: string;
}

/**
 * Cascade-create workspace + tab + agent, reusing each if it already exists.
 *
 * Order: agent check → workspace lookup/create → tab create → agent start.
 * Returns the pane id of the freshly-started agent.
 */
export async function ensureWorkspaceTabAgent(
	cwd: string,
	label: string,
	signal?: AbortSignal,
	agentKind = "pi",
): Promise<Result<CascadeResult>> {
	// Step 1: agent (noop check only — bail out early if one already exists).
	const listA = await herdr<[Record<string, unknown>]>(
		["agent", "list"],
		{ timeoutMs: 10_000, signal },
	);
	if (!listA.ok) return listA;

	let agents: Record<string, unknown>[];
	if (Array.isArray(listA.data)) {
		agents = listA.data;
	} else if (
		typeof listA.data === "object" &&
		listA.data !== null
	) {
		agents = (listA.data.agents as Record<string, unknown>[]) ?? [];
	} else {
		agents = [];
	}

	const existingAgent = agents.find(
		(a) =>
			a.name === label ||
			(String(a.name ?? "").trim().toLowerCase() === label.trim().toLowerCase()),
	);
	if (existingAgent) {
		return {
			ok: true,
			data: {
				paneId: String(existingAgent.pane_id ?? ""),
				workspaceId: "",
			},
		};
	}

	// Step 2: workspace — reuse or create.
	let wsId: string | undefined;
	const listW = await herdr<[Record<string, unknown>]>(
		["workspace", "list"],
		{ timeoutMs: 10_000, signal },
	);
	if (!listW.ok) return listW;

	let workspaces: Record<string, unknown>[];
	if (Array.isArray(listW.data)) {
		workspaces = listW.data;
	} else if (
		typeof listW.data === "object" &&
		listW.data !== null
	) {
		workspaces = (listW.data.workspaces as Record<string, unknown>[]) ?? [];
	} else {
		workspaces = [];
	}

	const existingWs = workspaces.find(
		(ws) => String(ws.label ?? ws.workspace_name ?? "").trim().toLowerCase() === label.trim().toLowerCase(),
	);
	if (existingWs) {
		wsId = String(existingWs.id ?? existingWs.workspace_id ?? "");
	} else {
		const wArgs = ["workspace", "create", "--label", label, "--cwd", cwd];
		const createW = await herdr(wArgs, { timeoutMs: 30_000, signal });
		if (!createW.ok) return createW;

		const wr = createW.data as Record<string, unknown>;
		wsId = String(
			(wr.workspace as Record<string, unknown>)?.workspace_id ??
			wr.workspace_id ??
			"",
		);
	}

	// Step 3: tab (always create — the tab is where the new agent lives).
	const tArgs = ["tab", "create", "--workspace", wsId!, "--label", label, "--cwd", cwd];
	const createT = await herdr(tArgs, { timeoutMs: 30_000, signal });
	if (!createT.ok) return createT;

	const tr = createT.data as Record<string, unknown>;
	const paneId = String(
		(tr.root_pane as Record<string, unknown>)?.pane_id ??
		tr.root_pane?.pane_id ??
		"",
	);
	if (!paneId) {
		return err("VALIDATION_ERROR", "tab create succeeded but no root_pane returned");
	}

	// Step 4: agent start using tab's root_pane.
	const startR = await herdr(
		["agent", "start", label, "--kind", agentKind, "--pane", paneId],
		{ timeoutMs: 30_000, signal },
	);
	if (!startR.ok) return startR;

	// Verify the agent actually registered. `agent start` can return ok
	// without the agent being live (upstream herdr flake: the title-detection
	// read races with the shell's first prompt, and a timeout inside herdr
	// surfaces as a quiet success). `agent get <paneId>` is the ground truth.
	const getR = await herdr<unknown>(["agent", "get", paneId], {
		timeoutMs: 10_000, signal,
	});
	if (!getR.ok) {
		return err(
			"AGENT_START_FAILED",
			`agent start reported success but pane ${paneId} is not registered as an agent (herdr ${getR.error.code.toLowerCase()}: ${getR.error.message}). Try again — this is an upstream herdr flake.`,
			{ paneId, getError: getR.error },
		);
	}

	return {
		ok: true,
		data: { paneId, workspaceId: wsId },
	};
}

/** Resolve a flexible target (name/label/paneId) to a concrete pane id. */
export async function resolvePaneId(
	target: string,
	signal?: AbortSignal,
): Promise<Result<string>> {
	const r = await herdr<unknown>(["agent", "get", target], {
		timeoutMs: 10_000,
		signal,
	});
	if (!r.ok) return r as Result<string>;
	const a =
		(r.data as { agent?: Record<string, unknown> })?.agent ??
		(r.data as Record<string, unknown>);
	const pid = (a?.pane_id as string) ?? (a?.paneId as string);
	if (!pid) {
		return err("NOT_FOUND", `No pane found for target "${target}"`, r.data);
	}
	return { ok: true, data: pid };
}