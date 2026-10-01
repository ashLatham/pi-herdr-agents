// `herdr_delegate` — one-shot: cascade-create → boot → /new → /reload →
// prompt → wait for the agent to write its response to a file.
//
// The file-IPC pattern (agent writes reply to <cwd>/delegate_<name>.md,
// we poll for it) is the robust alternative to reading the TUI scrollback:
// unlimited length, no parse fragility, and decouples "agent finished"
// from "we read the right bytes".

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { herdr } from "../herdr.js";
import { err, extractText, type Result, type ToolReturn } from "../env.js";
import { ensureWorkspaceTabAgent, fail, okText, resolveHome, safeName } from "./cascade.js";
import { getAgentStatus, waitForStatus } from "./lifecycle.js";

/**
 * Type (and optionally submit) a prompt into an agent pane.
 * Uses `agent prompt` (type+submit in one call) or `pane send-text` (type only).
 */
export async function sendAgentPrompt(
	paneId: string,
	text: string,
	opts: { submit?: boolean; signal?: AbortSignal } = {},
): Promise<Result<true>> {
	const submit = opts.submit !== false;
	if (!submit) {
		const r = await herdr(["pane", "send-text", paneId, text], {
			timeoutMs: 15_000,
			signal: opts.signal,
		});
		return r.ok ? { ok: true, data: true } : r;
	}
	const r = await herdr(["agent", "prompt", paneId, text], {
		timeoutMs: 15_000,
		signal: opts.signal,
	});
	if (r.ok) return { ok: true, data: true };
	// herdr 0.8.2 (Windows + pi): `agent prompt` rejects an interactive-ready
	// pane with `agent_not_ready`. Submit pane-level instead — same bytes, no
	// agent-surface validation.
	if (r.error.code === "AGENT_NOT_READY") {
		return paneLevelSubmit(paneId, text, opts);
	}
	return r;
}

/**
 * Pane-level prompt submission for panes the agent surface refuses to prompt
 * (`AGENT_NOT_READY` — herdr 0.8.2 Windows/pi rejects `agent prompt` /
 * `agent send-keys` on interactive-ready panes). `pane send-text` + settled
 * Enter needs no agent validation and delivers the same bytes `agent prompt`
 * would (herdr's own text-then-Enter semantics, one layer down). The settle
 * delay is load-bearing: Enter racing the paste loses the turn (herdr #1878).
 */
async function paneLevelSubmit(
	paneId: string,
	text: string,
	opts: { signal?: AbortSignal } = {},
): Promise<Result<true>> {
	const tx = await herdr(["pane", "send-text", paneId, text], {
		timeoutMs: 15_000,
		signal: opts.signal,
	});
	if (!tx.ok) return tx;
	await sleep(600);
	if (opts.signal?.aborted) {
		return err("TIMEOUT", `prompt to pane ${paneId} aborted`);
	}
	const enter = await herdr(["pane", "send-keys", paneId, "Enter"], {
		timeoutMs: 15_000,
		signal: opts.signal,
	});
	return enter.ok ? { ok: true, data: true } : enter;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

// File-IPC poll tuning. Constants live here because they're intrinsic to
// the file-write protocol — not to any one tool's behaviour.
const POLL_MS = 5_000;
const NUDGE_COOLDOWN_MS = 30_000;
const MAX_NUDGE_COUNT = 2;

interface FileIpcResult {
	reply: string;
	nudgeCount: number;
}

/**
 * Poll until the agent writes its response to `filePath`. If the agent
 * settles to `idle` without writing, send up to MAX_NUDGE_COUNT reminders
 * (subject to NUDGE_COOLDOWN_MS). On `blocked`, the caller resolves the
 * block via the ask-user overlay, then the loop resumes.
 *
 * Returns the file contents plus the number of nudges sent.
 *
 * `onBlocked` chooses the wait-or-relay policy for the parent tool:
 *   - "wait": stay in the loop until the human answers the question
 *   - "return": short-circuit and return `{ aborted: true, question }`
 */
async function waitForResponseFile(
	paneId: string,
	filePath: string,
	opts: {
		signal?: AbortSignal;
		onBlocked: "wait" | "return";
		name: string;
	},
): Promise<Result<FileIpcResult> | { aborted: true; question: string }> {
	let nudgeCount = 0;
	let lastNudgeTime = Date.now();
	while (true) {
		if (existsSync(filePath)) break;

		const statusR = await getAgentStatus(paneId, opts.signal);
		const status = statusR.ok ? statusR.data : null;

		if (status === "blocked") {
			if (opts.onBlocked === "return") {
				const readArgs = [
					"agent", "read", paneId,
					"--source", "recent", "--lines", "50", "--format", "text",
				];
				const readR = await herdr<unknown>(readArgs, {
					timeoutMs: 15_000, signal: opts.signal, textOk: true,
				});
				const question = readR.ok ? extractText(readR.data) : "";
				return { aborted: true, question };
			}
			// onBlocked === "wait": keep polling until human resolves the block.
			await sleep(POLL_MS);
			continue;
		}

		if (status === "idle") {
			const now = Date.now();
			const cooldownRemaining = NUDGE_COOLDOWN_MS - (now - lastNudgeTime);
			if (cooldownRemaining > 0) {
				await sleep(cooldownRemaining);
				continue;
			}
			nudgeCount++;
			lastNudgeTime = now;
			if (nudgeCount <= MAX_NUDGE_COUNT) {
				const nudgeMsg = `You were supposed to write your answer to ${filePath}. ${nudgeCount === 1 ? "" : "Second warning: you ignored the previous attempt."}`;
				await sendAgentPrompt(paneId, nudgeMsg, { submit: true, signal: opts.signal });
				await sleep(POLL_MS);
				continue;
			}
			return err(
				"VALIDATION_ERROR",
				`Agent in pane ${paneId} failed to write response file ${filePath} even after ${MAX_NUDGE_COUNT} reminder(s).`,
				{ paneId, filePath, nudgeCount, code: "RESPONSE_FILE_NOT_WRITTEN" },
			);
		}

		// Normal progress (working/blocked handled above) — continue polling.
		await sleep(POLL_MS);
	}

	let reply: string;
	try {
		reply = readFileSync(filePath, "utf8");
	} catch {
		reply = "";
	}
	return { ok: true, data: { reply, nudgeCount } };
}

/**
 * Core executor shared by `herdr_delegate` and dynamic `delegate_<name>` tools.
 *
 * Cascade-creates an agent, waits for boot, resets its context (/new, /reload),
 * sends the prompt, polls for the response file, and returns the agent's answer.
 *
 * Extracted so that JSON-driven `delegate_*.json` tools can call the same logic
 * without re-implementing the lifecycle.
 */
export async function runDelegate(opts: {
	name?: string;
	cwd?: string;
	prompt: string;
	closeOnSuccess?: boolean;
	onBlocked: "wait" | "return";
	env?: Record<string, string>;
	signal?: AbortSignal;
}): Promise<ToolReturn> {
	// 1. start via cascade (reuse workspace/tab if they exist).
	const name = opts.name ?? `delegate-${Date.now()}`;
	const cwd = resolveHome(opts.cwd ?? process.cwd());
	const filePath = `${cwd}/delegate_${safeName(name)}.md`;
	const startR = await ensureWorkspaceTabAgent(cwd, name, opts.signal, "pi");
	if (!startR.ok) return fail(startR);
	const paneId = startR.data.paneId ?? null;
	if (!paneId) {
		return partial("cascade create returned no pane id", {
			name,
			error: startR.data,
		});
	}

	// Clean slate: delete any leftover response file from prior runs.
	try {
		unlinkSync(filePath);
	} catch {
		/* missing is fine */
	}

	// 2. boot gate: wait for the boot idle transition. A spawned pi that
	//    inherits the host's extensions/skills can spend ~40-60s in `unknown`
	//    before reaching idle, so CHECK it (don't send until the agent is
	//    actually idle/ready).
	const boot = await waitForStatus(paneId, ["idle"], opts.signal);
	if (!boot.ok) {
		return partial(
			`Agent in pane ${paneId} did not become idle (boot): ${boot.error.message}`,
			{ paneId, name, error: boot.error },
		);
	}
	await sleep(1500); // brief settle so the TUI input is ready (PRD §2.2)

	// 3. Build prompt with file-writing instruction appended. Use absolute
	//    path so it works regardless of what the agent cdd during execution.
	const fullPrompt = `${opts.prompt}\n\nWhen finished, write your final response to ${filePath} using the 'write' tool. Format the file as a markdown document containing only your answer — no shell prompts, no debug output, no error traces.`;

	// 3b. Reset: clear context, reload tools/skills.
	await sendAgentPrompt(paneId, "/new", { submit: true, signal: opts.signal });
	await sleep(2_000);
	await sendAgentPrompt(paneId, "/reload", { submit: true, signal: opts.signal });
	await sleep(2_000);

	// 3c. Submit prompt — retry on NOT_STARTED (prompt sent too early).
	let submitted = false;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (submitted) break;
		if (attempt > 0) await sleep(2_000);
		const sendR = await sendAgentPrompt(paneId, fullPrompt, {
			submit: true,
			signal: opts.signal,
		});
		if (!sendR.ok && sendR.error.message === "NOT_STARTED") continue;
		if (sendR.ok) submitted = true;
		else return fail(sendR);
	}

	// 4. Wait for the agent to enter "working" state — only then does
	//    the poll loop begin. This prevents spurious nudges caused by
	//    catching the agent in a brief idle window between tasks.
	const workingGate = await waitForStatus(paneId, ["working"], opts.signal);
	if (!workingGate.ok) {
		return partial(
			`Agent in pane ${paneId} did not enter working state (did not start executing prompt): ${workingGate.error.message}`,
			{ paneId, name, error: workingGate.error },
		);
	}

	// 5. File-IPC poll loop.
	const ipc = await waitForResponseFile(paneId, filePath, {
		signal: opts.signal,
		onBlocked: opts.onBlocked,
		name,
	});

	// 5a. blocked-and-return: caller relays the question.
	if ("aborted" in ipc) {
		return {
			content: [
				{
					type: "text",
					text: `Agent in pane ${paneId} is BLOCKED waiting for human input (ask-user). The text below is the QUESTION, not an answer — do not treat it as a result. To resolve: call ask_user with the question, then inject the answer — herdr_send_prompt("${paneId}", <answer>) for a FREEFORM overlay, or herdr_send_keys("${paneId}", ["enter"]) / ["down","enter"] to SELECT AN OPTION (typed text never reaches an option list) — then herdr_wait_agent("${paneId}", idle), then herdr_read_agent("${paneId}").\n\nQuestion from pane ${paneId}:\n${ipc.question || "(no question text captured)"}`,
				},
			],
			details: {
				blocked: true,
				question: ipc.question,
				paneId,
				name,
				onBlocked: opts.onBlocked,
			},
			isError: true,
		};
	}

	// 5b. file-IPC error (max nudges, etc.).
	if (!ipc.ok) return fail(ipc);

	// 6. closeOnSuccess.
	if (opts.closeOnSuccess) {
		await herdr(["pane", "close", paneId], {
			timeoutMs: 15_000,
			signal: opts.signal,
		});
	}

	return okText(ipc.data.reply || "(agent produced no captured output)", {
		paneId,
		name,
		response: ipc.data.reply,
		filePath,
		closed: Boolean(opts.closeOnSuccess),
	});
}

export function registerDelegate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_delegate",
		label: "Delegate to a herdr agent (one-shot)",
		description:
			"Spawn a fresh agent, send a prompt, wait for it to finish, and return its response text — " +
			"all in one call. The default is to keep the pane alive for follow-ups (set closeOnSuccess to close it). " +
			"If the agent blocks on an ask-user question, onBlocked decides whether this call waits for a " +
			'human in the spawned pane ("wait", default, no time bound) or returns the question for the ' +
			'orchestration session to relay ("return").',
		promptSnippet:
			"One-shot delegate: spawn an agent, send a prompt, wait, return its reply",
		promptGuidelines: [
			"Use herdr_delegate for one-shot delegation: it spawns an agent, sends the prompt, waits for idle, and returns the response.",
			'If herdr_delegate returns a BLOCKED result (details.blocked === true), the returned text is the agent\'s QUESTION, not its answer — relay it: call ask_user with the question, then inject the answer — herdr_send_prompt(paneId, answer) for a FREEFORM overlay, or herdr_send_keys(paneId, ["enter"])/["down","enter"] to SELECT AN OPTION (typed text never reaches an option list) — then herdr_wait_agent(paneId, idle), herdr_read_agent(paneId). This only happens with onBlocked: "return".',
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({
					description:
						"Agent pane name (must be unique). Default: delegate-<timestamp>.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the agent. Defaults to current working directory.",
				}),
			),
			prompt: Type.String({
				description: "Prompt to send to the spawned agent.",
			}),
			closeOnSuccess: Type.Optional(
				Type.Boolean({
					description:
						"Close the pane after a successful response (default false, keep alive).",
				}),
			),
			onBlocked: Type.Optional(
				StringEnum(["wait", "return"] as const, {
					description:
						"What to do when the spawned agent blocks on an ask-user question. " +
						'"wait" (default): keep this call open with NO time bound (only the ' +
						"parent abort stops it) until a human answers in the spawned pane, " +
						'then return the final answer. "return": return immediately with ' +
						"{blocked, question, paneId} so the orchestration session relays the " +
						"question (ask_user → herdr_send_prompt → herdr_wait_agent → " +
						'herdr_read_agent).',
				}),
			),
			env: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description:
						"Extra env vars (KEY=VALUE) for the agent. On macOS set PATH to your " +
						"shell PATH if herdr's server runs with launchd's minimal PATH " +
						"(e.g. via `brew services`), so a node-based agent like `pi` can find `node`.",
				}),
			),
		}),
		async execute(_id, p, signal) {
			return runDelegate({
				name: p.name,
				cwd: p.cwd,
				prompt: p.prompt,
				closeOnSuccess: p.closeOnSuccess,
				onBlocked: p.onBlocked ?? "wait",
				env: p.env,
				signal,
			});
		},
		renderCall(args, theme) {
			const cwdShort = args.cwd && args.cwd.startsWith(os.homedir())
				? "~" + args.cwd.slice(os.homedir().length)
				: args.cwd;
			let text = theme.fg("toolTitle", theme.bold("herdr_delegate "));
			text += theme.fg("accent", args.name || `delegate-${Date.now()}`);
			text += theme.fg("dim", `\n  cwd: ${cwdShort}`);
			const shortPrompt = args.prompt.length > 60 ? args.prompt.slice(0, 60) + "…" : args.prompt;
			text += theme.fg("dim", `\n  prompt: "${shortPrompt}"`);
			return new Text(text, 0, 0);
		},
	});
}

/** Build a partial-error ToolReturn that surfaces the underlying error to the LLM. */
function partial(message: string, details: unknown): ToolReturn {
	return {
		content: [{ type: "text", text: `Error (PARTIAL): ${message}` }],
		details,
		isError: true,
	};
}
