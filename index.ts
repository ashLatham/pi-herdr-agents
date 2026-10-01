// pi-herdr extension entry point.
// Registers the herdr tool surface.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestration } from "./tools/index.js";
import { registerSelfReport } from "./selfreport.js";

export default function (pi: ExtensionAPI): void {
	// Push this pi's own state to herdr so agent_status is reliable for everyone
	// (fixes herdr's working -> idle detection misses). No-op outside herdr.
	registerSelfReport(pi);

	registerOrchestration(pi);
}
