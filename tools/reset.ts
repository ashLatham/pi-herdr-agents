// herdr_reset_agent — reset a target agent's session and reload its
// extensions/skills, optionally switching the LLM model.
//
// Flow:
//   1. /new         → new session (clears context)
//   2. /reload      → reload skills + extensions
//   3. /model <m>   → only if `model` arg supplied
//        then ' '   → confirms the model picker
//
// Each step is a separate `agent prompt` call against the resolved pane id,
// matching the style of herdr_send_prompt (thin wrapper over `agent prompt`).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { herdr } from "../herdr.js";
import type { ToolReturn } from "../env.js";
import { fail, okText, resolvePaneId } from "./cascade.js";

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

async function sendText(
	paneId: string,
	text: string,
	signal: AbortSignal | undefined,
): Promise<ToolReturn | null> {
	const r = await herdr(["agent", "prompt", paneId, text], {
		timeoutMs: 15_000,
		signal,
	});
	if (!r.ok) {
		return fail(r);
	}
	return null;
}

export function registerReset(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_reset_agent",
		label: "Reset herdr agent",
		description:
			"Resets the agent, starting a new session, reloading extensions and skills and optionally setting the llm model.",
		promptSnippet: "Reset an agent (new session, reload, optional model switch)",
		promptGuidelines: [
			"Sends /new, /reload, and (if model is set) /model <model> to the target agent, waiting 1s between steps.",
			"Use after editing extensions/skills to pick up the new versions in the target agent.",
		],
		parameters: Type.Object({
			agent: Type.String({
				description: "Pane id (w1:p3), agent name, or label.",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"Optional LLM model identifier. When set, switches the target agent's model after /new + /reload.",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const pid = await resolvePaneId(p.agent, signal);
			if (!pid.ok) return fail(pid);
			const paneId = pid.data;

			const step1 = await sendText(paneId, "/new", signal);
			if (step1) return step1;
			await sleep(1_000);

			const step2 = await sendText(paneId, "/reload", signal);
			if (step2) return step2;
			await sleep(1_000);

			const steps: string[] = ["/new", "/reload"];
			if (p.model) {
				const step3 = await sendText(paneId, `/model ${p.model}`, signal);
				if (step3) return step3;
				await sleep(500);
				const step4 = await sendText(paneId, " ", signal);
				if (step4) return step4;
				steps.push(`/model ${p.model}`, "(confirm)");
			}

			return okText(
				`Reset agent "${p.agent}" (pane ${paneId}): ${steps.join(" → ")}.`,
				{ paneId, steps, model: p.model ?? null },
			);
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("herdr_reset_agent "));
			text += theme.fg("accent", args.agent ?? "");
			if (args.model) {
				text += theme.fg("dim", `\n  model: ${args.model}`);
			} else {
				text += theme.fg("dim", `\n  model: (unchanged)`);
			}
			return new Text(text, 0, 0);
		},
	});
}