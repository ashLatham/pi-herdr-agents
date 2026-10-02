// Tier 1 — Orchestration tools.
//
// Targeted at herdr >=0.7.5 with the redesigned `agent start --kind`,
// `agent prompt` (type+submit), and `agent wait --until` APIs.
// Each tool is a thin wrapper: build argv -> herdr() -> return a uniform ToolReturn.
//
// Split:
//   - cascade.ts  → ensureWorkspaceTabAgent, resolvePaneId, helpers
//   - lifecycle.ts→ wait/race/drive helpers
//   - delegate.ts → herdr_delegate (composite, file-IPC)
//   - index.ts    → the simple thin tools + herdr_new_agent

import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { herdr } from "../herdr.js";
import {
	extractText,
	normalizeAgent,
	normalizeWorkspace,
	type ToolReturn,
} from "../env.js";
import {
	ensureWorkspaceTabAgent,
	fail,
	okText,
	resolveHome,
	resolvePaneId,
} from "./cascade.js";
import { raceIdleDone, transitionWaitArgs } from "./lifecycle.js";
import { registerDelegate } from "./delegate.js";
import { registerReset } from "./reset.js";
import { registerSubAgents } from "./subagents.js";

export function registerOrchestration(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_send_prompt",
		label: "Send prompt to herdr agent",
		description:
			"Send text to an agent pane, optionally pressing Enter to submit (default: submit). " +
			"Targets a pane by id (w3:p1E), agent name, or label.",
		promptSnippet: "Type text into an agent pane",
		promptGuidelines: [
			"Use herdr_send_prompt to send a prompt to an agent pane, then herdr_wait_agent + herdr_read_agent to get the reply.",
			"Multi-choice overlays: typed text does NOT reach a pi ask-user option list — select with herdr_send_keys instead (bare 'Enter' picks option 1, 'down' then 'Enter' picks option 2). Typed text only lands in a focused freeform row.",
		],
		parameters: Type.Object({
			target: Type.String({
				description: "Pane id (w1:p3), agent name, or label.",
			}),
			text: Type.String({ description: "Prompt text to type." }),
			submit: Type.Optional(
				Type.Boolean({ description: "Press Enter to submit (default true)." }),
			),
		}),
		async execute(_id, p, signal) {
			const pid = await resolvePaneId(p.target, signal);
			if (!pid.ok) return fail(pid);
			const submitted = p.submit !== false;
			const sendR = await herdr(["agent", "prompt", pid.data, p.text], {
				timeoutMs: 15_000,
				signal,
			});
			if (!sendR.ok) return fail(sendR);
			return okText(
				`Sent prompt to "${p.target}" (pane ${pid.data})${submitted ? " and submitted" : " (text only, not submitted)"}.`,
				{ paneId: pid.data, submitted },
			);
		},
		renderCall(args, theme) {
			const submitted = args.submit !== false;
			const preview =
				args.text && args.text.length > 60
					? args.text.slice(0, 57) + "\u2026"
					: args.text ?? "";
			let text = theme.fg("toolTitle", theme.bold("herdr_send_prompt "));
			text += theme.fg("accent", args.target ?? "");
			text += theme.fg(
				"dim",
				`\n  submit: ${submitted}  text: ${preview}`,
			);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_read_agent",
		label: "Read herdr agent output",
		description:
			"Read text output from an agent pane. Supports 'recent' (scrollback), 'visible' (viewport), and 'recent-unwrapped' sources. " +
			"If truncated=true, the agent likely wrote more than fits — ask it to save to a file and provide the path.",
		promptSnippet: "Read an agent pane's output text",
		promptGuidelines: [
			"Use herdr_read_agent to fetch an agent's response after herdr_wait_agent reports idle.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
			source: Type.Optional(
				StringEnum(["recent", "visible", "recent-unwrapped"] as const, {
					description: "Output source (default 'recent').",
				}),
			),
			lines: Type.Optional(
				Type.Integer({ description: "Max lines to read (default 50)." }),
			),
			format: Type.Optional(
				StringEnum(["text", "ansi"] as const, {
					description: "Output format (default 'text').",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const source = p.source ?? "recent";
			const lines = p.lines ?? 50;
			const format = p.format ?? "text";
			const r = await herdr<unknown>(
				[
					"agent",
					"read",
					p.target,
					"--source",
					source,
					"--lines",
					String(lines),
					"--format",
					format,
				],
				{ timeoutMs: 15_000, signal, textOk: true },
			);
			if (!r.ok) return fail(r);
			const text = extractText(r.data);
			const truncated = Boolean((r.data as { truncated?: boolean })?.truncated);
			return okText(text || "(no output)", {
				paneId: p.target,
				text,
				truncated,
			});
		},
		renderCall(args, theme) {
			const source = args.source ?? "recent";
			const lines = args.lines ?? 50;
			const format = args.format ?? "text";
			let text = theme.fg("toolTitle", theme.bold("herdr_read_agent "));
			text += theme.fg("accent", args.target ?? "");
			text += theme.fg(
				"dim",
				`\n  source: ${source}  lines: ${lines}  format: ${format}`,
			);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_wait_agent",
		label: "Wait for herdr agent status",
		description:
			"Block until an agent pane enters the specified status. Polls indefinitely — no deadline-based timeout. " +
			"Default (omit status): races idle vs done, returns whichever fires first. " +
			"'idle'/'done': waits for completion (races idle vs done for panes with self-reporting). " +
			"'working': waits for the agent to start processing. " +
			"'blocked': waits for an ask-user event. " +
			"'unknown': waits for initial detection to complete.",
		promptSnippet: "Wait for an agent pane to reach idle/working/blocked",
		promptGuidelines: [
			"Omit status to wait for idle or done (completion). Use status='working' to wait for the agent to begin processing.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
			status: Type.Optional(
				StringEnum(
					["idle", "working", "blocked", "done", "unknown"] as const,
					{
						description: "Status to wait for. Defaults to idle-or-done (completion). Polls indefinitely until the abort signal fires.",
					},
				),
			),
		}),
		async execute(_id, p, signal) {
			const reached = (msg: string, agentStatus: string): ToolReturn =>
				okText(msg, { paneId: p.target, agentStatus });
			const status = p.status ?? null;
			// idle/done/null (default): race the transition waits. Self-report
			// yields `done`, auto-detect yields `idle`; we wait for whichever fires first.
			if (status === null || status === "idle" || status === "done") {
				const r = await raceIdleDone(p.target, signal);
				if (!r.ok) return fail(r);
				return reached(
					`Agent "${p.target}" reached completion.`,
					"idle-or-done",
				);
			}
			// working/blocked/unknown: `agent wait --until <s>` polls until status change or abort.
			const r = await herdr<unknown>(
				transitionWaitArgs(p.target, [status]),
				{ signal },
			);
			if (!r.ok) return fail(r);
			return reached(
				`Agent "${p.target}" reached status "${status}".`,
				status,
			);
		},
	});

	pi.registerTool({
		name: "herdr_list",
		label: "List herdr agents or workspaces",
		description:
			"List herdr resources. Pass type='agent' for agent panes (pane id, status, title) or type='workspace' for workspaces (workspace id, label, status, pane/tab counts).",
		promptSnippet: "List agents or workspaces",
		promptGuidelines: [
			"Use herdr_list(type='agent') to see what agent panes exist and their idle/working status.",
			"Use herdr_list(type='workspace') to see what workspaces exist, their labels, and counts.",
		],
		parameters: Type.Object({
			type: StringEnum(["agent", "workspace"] as const, {
				description:
					"Resource type: 'agent' lists agents, 'workspace' lists workspaces.",
			}),
		}),
		async execute(_id, p, signal) {
			if (p.type === "workspace") {
				const r = await herdr<{ workspaces?: Record<string, unknown>[] }>(
					["workspace", "list"],
					{
						timeoutMs: 10_000,
						signal,
					},
				);
				if (!r.ok) return fail(r);
				const workspaces = (r.data?.workspaces ?? []).map(normalizeWorkspace);
				return okText(
					workspaces.length
						? `${workspaces.length} workspace(s):\n` +
								workspaces
									.map(
										(w) =>
											`${w.workspaceId ?? "?"} [${w.status ?? "?"}] ${w.label ?? "?"} (panes: ${w.paneCount ?? "?"}, tabs: ${w.tabCount ?? "?"})`,
									)
									.join("\n")
						: "No workspaces found.",
					{ workspaces },
				);
			}
			// type === "agent"
			const r = await herdr<{ agents?: Record<string, unknown>[] }>(
				["agent", "list"],
				{
					timeoutMs: 10_000,
					signal,
				},
			);
			if (!r.ok) return fail(r);
			const agents = (r.data?.agents ?? []).map(normalizeAgent);
			return okText(
				agents.length
					? `${agents.length} agent(s):\n` +
							agents
								.map(
									(a) =>
										`${a.paneId ?? "?"} [${a.agentStatus ?? "?"}] ${a.terminalTitle ?? a.name ?? "?"} (${a.agent ?? "?"})`,
								)
								.join("\n")
					: "No agents running.",
				{ agents },
			);
		},
	});

	pi.registerTool({
		name: "herdr_close",
		label: "Close a herdr resource",
		description:
			"Destructively close a resource. Panes terminate the agent inside them; tabs remove the UI container (agent may survive); workspaces remove everything under them. " +
			"Never close pre-existing resources. Always close BOTH pane AND workspace when removing test resources — closing only the pane leaves an orphaned workspace.",
		promptSnippet: "Close a herdr resource (destructive)",
		promptGuidelines: [
			"type='pane': close an agent pane (terminates the agent). Target by pane id or agent name/label.",
			"type='tab': close a tab (removes the tab, agent may survive). Target by tab id.",
			"type='workspace': close a workspace (removes everything). Target by workspace id or label.",
		],
		parameters: Type.Object({
			type: StringEnum(
				["pane", "tab", "workspace"] as const,
				{ description: "Resource type to close: pane, tab, or workspace." },
			),
			target: Type.String({
				description:
					"Target identifier: pane id (for type=pane), tab id (for type=tab), or workspace id/label (for type=workspace).",
			}),
		}),
		async execute(_id, p, signal) {
			let resolved: string;
			switch (p.type) {
				case "pane": {
					const pid = await resolvePaneId(p.target, signal);
					if (!pid.ok) return fail(pid);
					resolved = pid.data;
					break;
				}
				case "tab":
					resolved = p.target;
					break;
				case "workspace":
					resolved = p.target;
					break;
			}
			const cmd = [p.type, "close", resolved];
			const r = await herdr(cmd, {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			const typeLabel = p.type.charAt(0).toUpperCase() + p.type.slice(1);
			return okText(`${typeLabel} closed (${resolved}).`, {
				type: p.type,
				target: resolved,
				closed: true,
			});
		},
	});

	pi.registerTool({
		name: "herdr_new_agent",
		label: "Cascade-create workspace, tab, then agent — skip each if it exists",
		description:
			"Cascade-create workspace → tab → agent, skipping each if it already exists. " +
			"The label is applied to all three resources. Always starts a pi agent. " +
			"Returns both the pane ID and workspace ID for later cleanup.",
		promptSnippet: "Create workspace→tab→agent, starting a pi agent",
		promptGuidelines: [
			"Creates a workspace and tab only if missing, then starts a pi agent. Reuses existing resources.",
			"Save the returned paneId and workspaceId — both must be closed later (see herdr_close).",
		],
		parameters: Type.Object({
			cwd: Type.String({
				description: "Working directory for the workspace.",
			}),
			label: Type.String({
				description: "Label used for workspace, tab, and agent names.",
			}),
		}),
		async execute(_id, p, signal) {
			const cwd = resolveHome(p.cwd);
			const label = p.label;

			if (!cwd || !label) {
				return fail(
					{
						ok: false,
						error: {
							code: "VALIDATION_ERROR",
							message: "Both 'cwd' and 'label' parameters are required.",
						},
					},
				);
			}

			const r = await ensureWorkspaceTabAgent(cwd, label, signal);
			if (!r.ok) return fail(r);
			return okText(
				`Created agent pane ${r.data.paneId}`,
				{ paneId: r.data.paneId, workspaceId: r.data.workspaceId },
			);
		},
		renderCall(args, theme) {
			const cwdShort = args.cwd?.startsWith(os.homedir())
				? "~" + args.cwd!.slice(os.homedir().length)
				: args.cwd ?? "…";
			let text = theme.fg("toolTitle", theme.bold("herdr_new_agent "));
			text += theme.fg("accent", args.label ?? "");
			text += theme.fg("dim", `\n  cwd: ${cwdShort}`);
			return new Text(text, 0, 0);
		},
	});

	registerDelegate(pi);
	registerReset(pi);
	registerSubAgents(pi);
};