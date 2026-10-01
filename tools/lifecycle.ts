// Status lifecycle helpers: poll for `idle`/`working`/`done`/`blocked`,
// race the event command against a polling fallback, drive a single turn.
//
// Why polling alongside `agent wait --until`: some herdr builds miss the
// working → idle transition (TUI detection races with terminal repaints),
// so a single event-based wait can hang. The poll on `agent get` is the
// load-bearing path; the event command is a fast first-to-finish lane.

import { herdr } from "../herdr.js";
import { err, extractText, type Result } from "../env.js";

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** Build argv for `agent wait <target> --until <s> [--until <s>...]`. */
export function transitionWaitArgs(
	target: string,
	statuses: string[],
): string[] {
	const args = ["agent", "wait", target];
	for (const s of statuses) args.push("--until", s);
	return args;
}

/**
 * Wait for `paneId` to reach one of `statuses`.
 *
 * Races the event command `agent wait --until ...` against a polling
 * fallback (`agent get`). The event promise resolves ONLY on success —
 * on error it stays pending so the poll decides. Whichever path sees a
 * target status first wins; the other is cancelled. The poll is what
 * makes completion detection robust instead of depending on a flaky
 * event command.
 *
 * Polls indefinitely until the abort signal fires — no deadline-based timeout.
 */
export async function waitForStatus(
	paneId: string,
	statuses: string[],
	signal?: AbortSignal,
): Promise<Result<true>> {
	const want = new Set(statuses);
	const ctrl = new AbortController();
	const onParentAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) {
			return err("TIMEOUT", "aborted");
		}
		signal.addEventListener("abort", onParentAbort, { once: true });
	}
	type Resolved = { via: "event" | "poll"; r: Result<true> };
	// Event path: resolves only on a successful transition (errors swallowed so
	// the polling fallback gets to run). `agent wait --until` supports multiple
	// states in one call.
	const events = new Promise<Resolved>((resolve) => {
		herdr(transitionWaitArgs(paneId, statuses), {
			signal: ctrl.signal,
		}).then((r) => {
			if (r.ok) resolve({ via: "event", r: { ok: true, data: true } });
		});
	});
	// Polling fallback: `agent get` is reliable when `wait agent-status` misbehaves.
	const poll: Promise<Resolved> = (async () => {
		while (!ctrl.signal.aborted) {
			const r = await herdr<{
				agent?: { agent_status?: string };
				agent_status?: string;
			}>(["agent", "get", paneId], { timeoutMs: 8_000, signal: ctrl.signal });
			if (r.ok) {
				const st = (r.data?.agent ?? r.data)?.agent_status;
				if (st && want.has(st)) {
					return { via: "poll", r: { ok: true, data: true } };
				}
			}
			await sleep(800);
		}
		return {
			via: "poll",
			r: err("TIMEOUT", "aborted"),
		};
	})();
	try {
		const first = await Promise.race([events, poll]);
		ctrl.abort(); // cancel the still-running path
		return first.r;
	} finally {
		if (signal) signal.removeEventListener("abort", onParentAbort);
	}
}

/**
 * Wait for a pane to reach idle OR done, whichever fires first.
 * Polls indefinitely until the abort signal fires — no deadline-based timeout.
 */
export async function raceIdleDone(
	paneId: string,
	signal?: AbortSignal,
): Promise<Result<true>> {
	return waitForStatus(paneId, ["idle", "done"], signal);
}

/** Read the live agent_status of a pane (idle/working/blocked/done/unknown). */
export async function getAgentStatus(
	paneId: string,
	signal?: AbortSignal,
): Promise<Result<string>> {
	const r = await herdr<{
		agent?: { agent_status?: string };
		agent_status?: string;
	}>(["agent", "get", paneId], { timeoutMs: 10_000, signal });
	if (!r.ok) return r;
	const st = (r.data?.agent ?? r.data)?.agent_status;
	if (!st) {
		return err("VALIDATION_ERROR", `agent get returned no status for ${paneId}`);
	}
	return { ok: true, data: st };
}

/**
 * Wait for a BLOCKED (ask-user) pane to resolve, with NO time bound — only the
 * parent signal aborts. A human answers in the spawned pane; ask-user fires
 * active:false → working → idle (see src/selfreport.ts), and we return once the
 * pane is truly settled (idle/done), looping past follow-up questions (blocked
 * again) and the resumed working phase. Polls indefinitely until abort.
 */
export async function waitForBlockedResolved(
	paneId: string,
	signal?: AbortSignal,
): Promise<Result<true>> {
	if (signal?.aborted) {
		return err("TIMEOUT", "aborted");
	}
	for (;;) {
		const r = await raceIdleDone(paneId, signal);
		if (signal?.aborted) {
			return err("TIMEOUT", "aborted");
		}
		if (r.ok) {
			const s = await getAgentStatus(paneId, signal);
			if (s.ok && (s.data === "idle" || s.data === "done")) {
				return { ok: true, data: true };
			}
			// else: blocked again (another question) or resumed working — keep waiting
		}
		// poll timed out without settling → loop (unbounded unless aborted)
		await sleep(1_000);
	}
}

/**
 * Drive a spawned agent through one turn.
 *
 * Phase 1 (start): `wait agent-status working` — herdr's idle->working
 * transition is reliable (both auto-detect and self-report).
 *
 * Phase 2 (finish): race `idle`/`done` (see raceIdleDone). Polls indefinitely
 * until abort signal fires — no deadline-based timeout.
 * self-report (the reliable signal) or herdr's auto-detect; we never force the
 * state ourselves, so we can't report a still-working pane as idle.
 *
 * Returns ok on completion, or an error whose `message` is "NOT_STARTED" when
 * the turn never entered working (caller may re-send the prompt).
 */
export async function driveOneTurn(
	paneId: string,
	opts: { signal?: AbortSignal },
): Promise<Result<true>> {
	const { signal } = opts;
	const working = await waitForStatus(paneId, ["working"], signal);
	if (!working.ok) {
		return { ok: false, error: { ...working.error, message: "NOT_STARTED" } };
	}
	return raceIdleDone(paneId, signal);
}

// Degraded-mode turn driver. Heuristic: a working pi TUI repaints continuously
// (spinner, status line, token counts), so N consecutive identical reads after
// a floor mean the turn settled. ponytail: swap back to `agent wait` once herdr's
// process tracking is fixed upstream.
const READ_STABLE_POLLS = 3;
const READ_STABLE_FLOOR_MS = 10_000;

/**
 * Degraded-mode turn driver for panes where herdr's lifecycle tracking is
 * unusable (0.8.2 Windows/pi `agent_not_ready` panes report `idle` through an
 * entire working turn, so `agent wait` returns instantly).
 */
export async function driveOneTurnReadStable(
	paneId: string,
	opts: {
		signal?: AbortSignal;
		/** Set `sawBlocked = true` if the pane ever reports `blocked` — a short
		 * ask-user episode can resolve before the caller samples status. */
		observed?: { sawBlocked?: boolean };
	},
): Promise<Result<true>> {
	const t0 = Date.now();
	let last: string | null = null;
	let stable = 0;
	while (!opts.signal?.aborted) {
		const r = await herdr<unknown>(
			[
				"agent",
				"read",
				paneId,
				"--source",
				"recent-unwrapped",
				"--lines",
				"80",
				"--format",
				"text",
			],
			{ textOk: true, timeoutMs: 15_000, signal: opts.signal },
		);
		const txt = r.ok
			? String(extractText(r.data) ?? "")
			: `__read_err_${r.error?.code}`;
		if (txt === last) stable++;
		else {
			stable = 0;
			last = txt;
		}
		if (opts.observed && !opts.observed.sawBlocked) {
			const s = await getAgentStatus(paneId, opts.signal);
			if (s.ok && s.data === "blocked") opts.observed.sawBlocked = true;
		}
		if (stable >= READ_STABLE_POLLS && Date.now() - t0 >= READ_STABLE_FLOOR_MS) {
			return { ok: true, data: true };
		}
		await sleep(2_000);
	}
	return err(
		"TIMEOUT",
		`turn in pane ${paneId} did not settle (screen still changing) before abort`,
	);
}