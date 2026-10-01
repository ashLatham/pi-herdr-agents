# Herdr Tools End-to-End Test Suite

⚠️ CRITICAL RULE: NEVER close agents or workspaces that existed BEFORE you started testing.
Only ever close agents or workspaces whose IDs you received FROM the test tools themselves.
A single test run can leave behind dozens of orphaned test workspaces — always clean up both the agent pane AND its workspace.

Note: `herdr_new_agent` and `herdr_delegate` both cascade-create a workspace → tab → agent chain. Closing only the agent pane (via `herdr_close(type='pane')`) leaves the workspace alive forever. Always close BOTH: the pane AND the workspace.

## CWD convention

All test calls use the **orchestrator's cwd** — the directory the parent pi session is running in. The tests below show `cwd="/home/ash/Work"` as the worked example, but you must substitute whatever your orchestrator's `process.cwd()` actually is. Get it with:

```bash
pwd
```

Every `herdr_new_agent` and `herdr_delegate` call in this suite takes that path. Substituting it is required for tests to be reproducible — the runner pane itself must also be spawned at this cwd so any relative paths it uses resolve identically.

Run these tests sequentially. For each test: execute the steps, verify the outcome, then follow the cleanup instructions before proceeding.

---

## Pre-flight: Record existing resources (DO NOT CLOSE)

Before starting, record what already exists — do NOT close anything.

```bash
herdr_list(type='agent')
herdr_list(type='workspace')
```

Write down the workspace IDs and agent pane IDs that already exist. Leave them all untouched. These are your baseline — nothing you close should match these.

---

## Test 1: herdr_new_agent — Basic creation

**Purpose**: Verify herdr_new_agent creates a workspace → tab → agent chain and returns a valid pane ID.

### Steps

1. Call `herdr_new_agent(cwd="/home/ash/Work", label="test-new-agent-1")`

   ⚠️ ONLY close the specific pane ID and workspace ID you receive back — never touch pre-existing ones.

   Expected: Returns a string like `"wX:pY"` (workspace:pane format). The value must be non-empty. Save both values.

2. Call `herdr_list(type='agent')`

   Expected: One new agent appears in the list. It should reference the pane ID returned in step 1. Status should be `"idle"` initially. Other pre-existing agents may also appear — that's fine.

3. Call `herdr_list(type='workspace')`

   Expected: A new workspace with label `"test-new-agent-1"` appears in the list. Its `workspaceId` matches the first component of the pane ID (e.g., `"wX"`). Save this workspace ID.

### Cleanup

⚠️ Close BOTH the pane AND the workspace — closing only the pane leaves an orphaned workspace. Never close pre-existing resources.

```bash
herdr_close(type='pane', target='<pane_id>')      # the pane ID from step 1
herdr_close(type='workspace', target='<ws_id>')    # the workspace ID from step 3
```

---

## Test 2: herdr_new_agent — Idempotency (duplicate label)

**Purpose**: Verify calling herdr_new_agent with the same label does NOT create a second agent — it reuses the existing one.

### Steps

1. Call `herdr_new_agent(cwd="/home/ash/Work", label="test-idempotent-label")`

   Expected: Returns a pane ID, e.g., `"wX:pY"`. Save both the pane ID and workspace ID.

2. Call `herdr_new_agent(cwd="/home/ash/Work", label="test-idempotent-label")` again with the **same** label.

   Expected: Returns the **exact same** pane ID as step 1. A new agent should NOT be created.

3. Call `herdr_list(type='agent')`

   Expected: Only **one** agent with this label/pane ID exists. If there are two identical labels, the test fails.

4. Call `herdr_list(type='workspace')`

   Expected: Only **one** workspace with label `"test-idempotent-label"` exists. Save this workspace ID.

### Cleanup

⚠️ Close BOTH the pane AND the workspace — never close pre-existing ones.

```bash
herdr_close(type='pane', target='<pane_id>')
herdr_close(type='workspace', target='<ws_id>')
```

---

## Test 3: herdr_delegate — Single-shot spawn, prompt, respond

**Purpose**: Verify herdr_delegate spawns an agent, sends a prompt, waits for completion, and returns the full response text.

### Steps

1. Call `herdr_delegate(name="test-delegate-simple", cwd="/home/ash/Work", prompt="Reply with exactly: HERDR_TEST_OK", closeOnSuccess=false, onBlocked="wait")`

   Expected: The function returns a string containing `"HERDR_TEST_OK"`. The response should be roughly the entire output from the agent in that session.

2. Call `herdr_list(type='agent')`

   Expected: An agent named `"test-delegate-simple"` (or similar) is listed. Status depends on whether it finished — likely `"done"` if the prompt executed quickly.

3. Call `herdr_list(type='workspace')`

   Expected: A workspace with label `"test-delegate-simple"` exists. Save this workspace ID.

### Cleanup

⚠️ Close BOTH the pane AND the workspace — never close pre-existing ones.

```bash
herdr_close(type='pane', target='<pane_id>')
herdr_close(type='workspace', target='<ws_id>')
```

---

## Test 4: herdr_send_prompt + herdr_read_agent — Prompt and read response

**Purpose**: Verify herdr_send_prompt delivers a message to an agent and herdr_read_agent retrieves the agent's output.

### Setup — Create an agent to work with

1. Call `herdr_new_agent(cwd="/home/ash/Work", label="test-send-read-a")`

   Expected: Returns a pane ID, e.g., `"wX:pY"`. Save both the pane ID and workspace ID.

2. Wait briefly for the agent to become ready (let it settle into idle state). You can optionally call `herdr_wait_agent(target="test-send-read-a", status="idle")` and skip ahead if it succeeds.

### Step A — Send a prompt

3. Call `herdr_send_prompt(target="test-send-read-a", text="Reply with exactly: SEND_READ_OK", submit=true)`

   Expected: No error. The agent receives the prompt and processes it.

4. Call `herdr_wait_agent(target="test-send-read-a", status="idle")`

   Expected: Returns without blocking — the agent reached idle, meaning it finished processing the prompt.

### Step B — Read the response

5. Call `herdr_read_agent(target="test-send-read-a", lines=50, source="recent")`

   Expected: The returned text contains `"SEND_READ_OK"`.

### Cleanup

⚠️ Close BOTH the pane AND the workspace — never close pre-existing ones.

```bash
herdr_close(type='pane', target='<pane_id>')
herdr_close(type='workspace', target='<ws_id>')
```

---

## Test 5: herdr_wait_agent — Status transition detection

**Purpose**: Verify herdr_wait_agent correctly detects when an agent moves between statuses (e.g., idle → working → idle).

### Setup — Create an agent

1. Call `herdr_new_agent(cwd="/home/ash/Work", label="test-wait-status-b")`

   Expected: Returns a pane ID, e.g., `"wX:pY"`. Save both the pane ID and workspace ID.

2. Confirm initial idle:

   ```bash
   herdr_wait_agent(target="test-wait-status-b", status="idle")
   ```

   Expected: Returns immediately (agent is already idle).

### Step A — Trigger working status

3. Call `herdr_send_prompt(target="test-wait-status-b", text="Take a long time thinking about a complex problem. When done, reply with: DONE_THINKING", submit=true)`

   Expected: Prompt sent. The agent enters `"working"` state.

4. Call `herdr_wait_agent(target="test-wait-status-b", status="working")`

   Expected: This blocks until the agent becomes working, then returns. Confirms the agent entered the working state.

### Step B — Wait for completion

5. Call `herdr_wait_agent(target="test-wait-status-b", status="idle")`

   Expected: Blocks until the agent finishes and returns to idle.

### Verification

6. Read the agent's output:

   ```bash
   herdr_read_agent(target="test-wait-status-b", lines=50)
   ```

   Expected: Response contains `"DONE_THINKING"`.

### Cleanup

⚠️ Close BOTH the pane AND the workspace — never close pre-existing ones.

```bash
herdr_close(type='pane', target='<pane_id>')
herdr_close(type='workspace', target='<ws_id>')
```

---

## Test 6: herdr_list — Accurate multi-resource listing

**Purpose**: Verify herdr_list accurately reports both agents and workspaces.

### Setup — Create multiple agents

1. Call `herdr_new_agent(cwd="/home/ash/Work", label="test-list-1")`

   Expected: Pane ID and workspace ID returned. Save both.

2. Call `herdr_new_agent(cwd="/home/ash/Work", label="test-list-2")`

   Expected: Different pane ID and workspace ID returned. Save both.

### Step A — List agents

3. Call `herdr_list(type='agent')`

   Expected: At least two agents appear in the list. Both `"test-list-1"` and `"test-list-2"` should be present. Each entry includes a pane ID, status, and terminal title. Other pre-existing agents may also show up.

### Step B — List workspaces

4. Call `herdr_list(type='workspace')`

   Expected: At least two workspaces appear. Both `"test-list-1"` and `"test-list-2"` labels should be present. Each entry includes workspace ID, label, status, pane count, and tab count.

### Cleanup

⚠️ Close BOTH the pane AND the workspace for EACH test resource — never close pre-existing ones.

```bash
herdr_close(type='pane', target='<pane_id_for_test-list-1>')
herdr_close(type='pane', target='<pane_id_for_test-list-2>')
herdr_close(type='workspace', target='<ws_id_for_test-list-1>')
herdr_close(type='workspace', target='<ws_id_for_test-list-2>')
```

---

## Test 7: herdr_close — Destructive termination and verification

**Purpose**: Verify herdr_close(type='pane') terminates an agent AND herdr_close(type='workspace') removes the workspace.

### Setup — Create an agent

1. Call `herdr_new_agent(cwd="/home/ash/Work", label="test-close-cleanup")`

   Expected: Pane ID returned, e.g., `"wX:pY"`, and workspace ID (first part of pane ID), e.g., `"wX"`. Save both.

2. Verify agent exists:

   ```bash
   herdr_list(type='agent')
   ```

   Expected: Agent `"test-close-cleanup"` appears in the list.

3. Verify workspace exists:

   ```bash
   herdr_list(type='workspace')
   ```

   Expected: Workspace with label `"test-close-cleanup"` appears in the list.

### Step A — Close the agent pane

4. Call `herdr_close(type='pane', target="test-close-cleanup")`

   Expected: No error. The agent pane is closed.

### Verification A — Agent gone

5. Call `herdr_list(type='agent')`

   Expected: `"test-close-cleanup"` no longer appears in the agent list.

### Step B — Close the workspace

6. Call `herdr_close(type='workspace', target='<workspace_id>')`

   Expected: No error. Workspace closed.

### Verification B — Workspace gone

7. Call `herdr_list(type='workspace')`

   Expected: `"test-close-cleanup"` no longer appears in the workspace list.

---

## Post-flight: Clean up ONLY resources you created

After all tests complete, close ONLY agents and workspaces you created during testing — never pre-existing ones.

First get the current state:

```bash
herdr_list(type='agent')
herdr_list(type='workspace')
```

Compare against your pre-flight notes. Only close resources whose IDs you see here that you did NOT write down earlier.

For each resource you created, close BOTH types:

```bash
herdr_close(type='pane', target='<your_created_pane_ids_only>')
herdr_close(type='workspace', target='<your_created_ws_ids_only>')
```

Final verification:

```bash
herdr_list(type='agent')
herdr_list(type='workspace')
```

Expected: Any agents/workspaces you created are gone; pre-existing ones remain untouched.
