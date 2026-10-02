# herdr-agents

Pi extension providing orchestration tools for managing AI agents inside herdr panes.

## Tools

### herdr_new_agent

Cascade-create workspace → tab → agent — skips any resource that already exists. Always starts a **pi** agent if none exists under the target tab. Returns the pane ID.

Both `~` and `/home/ash/` paths resolve identically — tilde expansion happens automatically before the CLI is called.

#### Parameters

Both parameters required:

| Parameter | Type | Description |
|-----------|------|-------------|
| `cwd` | string | Working directory for the workspace. |
| `label` | string | Label used for workspace, tab, and agent names. |

#### Flow

1. **Agent** — If an agent with this label already exists: noop (return existing pane id).
2. **Workspace** — If a workspace with this label doesn't exist: create one (`--label <label> --cwd <cwd>`). Otherwise reuse.
3. **Tab** — Created (`--workspace <wsId> --label <label> --cwd <cwd>`). Response includes `root_pane.pane_id`.
4. **Agent start** — Launches the pi agent via `herdr agent start <label> --kind pi --pane <root_pane.pane_id>`.

#### Example Usage

```
herdr_new_agent(cwd="/home/ash/Work", label="my-project")
```

In the TUI the tool displays its label and cwd alongside the header.

---

### herdr_send_prompt

Send a prompt to an agent pane. With `submit=true` (default), presses Enter after typing. In the TUI the tool displays the target, submit flag, and the first ~60 chars of the text alongside the header.

### herdr_read_agent

Read recent/visible output text from an agent pane. In the TUI the tool displays the target, source, lines, and format alongside the header.

### herdr_wait_agent

Block until an agent pane reaches a given status (`idle`/`working`/`blocked`/`done`/`unknown`).

### herdr_list

List resources in herdr. Takes a `type` parameter: `"agent"` lists all agent panes with pane id, status, and terminal title; `"workspace"` lists all workspaces with workspace id, label, status, and counts.

### herdr_close

Destructively close a pane, tab, or workspace. Accepts `type` ("pane", "tab", or "workspace") and `target` parameters.

For workspace cleanup after closing an agent pane, always also close the workspace — closing only the agent pane leaves the workspace alive.

### herdr_reset_agent

Resets the agent, starting a new session, reloading extensions and skills, and optionally setting the LLM model. Accepts `agent` (pane id, agent name, or label) and an optional `model` (LLM model identifier). Flow: `/new` → 1s → `/reload` → 1s → (if `model` set) `/model <model>` → 0.5s → ` ` (confirm). In the TUI the tool displays the target agent and model alongside the header.

### herdr_delegate

Spawn a fresh agent, send a prompt, wait for completion, and return the response — all in one call. Default name follows the convention `delegate-<timestamp>`. Uses the same cascade path as `herdr_new_agent` so labels/cwd are reused across calls instead of creating duplicate tabs/workspace each time.

Handles blocked agents automatically based on the `onBlocked` parameter:
- **`onBlocked: "wait"`** (default) — blocks until the human answers the question in the spawned pane, then returns the final answer.
- **`onBlocked: "return"`** — returns immediately with `{ blocked: true, question: "..." }` so the orchestrator can relay the question to the user, inject the answer via `herdr_send_prompt`, then continue.

Tilde paths resolve correctly (`~/path` → `/home/ash/path`) before being passed to the CLI.

#### Example Usage

```bash
herdr_delegate(prompt="What files are in ~/data?", closeOnSuccess=true)
```

In the TUI the tool displays its name, cwd, and the first ~60 chars of the prompt alongside the header.


## Links

- GitHub: https://github.com/ashLatham/pi-herdr-agents
- Pi Agent: https://github.com/earendil-works/pi
- Herdr: https://github.com/herdrdev/herdr 

## License
MIT
