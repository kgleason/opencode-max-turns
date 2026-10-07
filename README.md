# opencode-max-turns

OpenCode plugin that enforces a hard turn limit on sessions. Designed for CI
and automation pipelines where an agent that spirals on exploration must fail
fast at a known step count rather than burning wall-clock time.

## Why

`opencode run` has no `--max-turns` flag. The old `claude` CLI did, and
automated review pipelines (like [pr-swarm](https://github.com/S2AI/Foresight))
depended on it to bound reviewer exploration. Without a hard cap, a reviewer
that hits an interesting rabbit hole burns every turn until the wall-clock
timeout — paying full cost for zero findings.

This plugin gives you that cap back.

## Install

```bash
opencode plugin add kgleason/opencode-max-turns
```

Or in `opencode.jsonc`:

```jsonc
{
  "plugins": ["kgleason/opencode-max-turns"]
}
```

## Usage

Set `OPENCODE_MAX_TURNS` in the environment where `opencode run` executes:

```bash
export OPENCODE_MAX_TURNS=20
opencode run "Review this PR for security issues" --agent build --auto --format json
```

The plugin is a no-op when the variable is unset or zero, so it's safe to
install globally.

## Per-role budgets

Each spawn gets its own budget by setting the variable per-invocation — no
global config needed:

```bash
# security reviewer — 20 turns (deep exploration)
OPENCODE_MAX_TURNS=20 timeout 1200 opencode run "$PROMPT" \
  --model "armature-gw/pr-swarm-security" --agent build --auto --format json

# verification reviewer — 16 turns (lighter lift)
OPENCODE_MAX_TURNS=16 timeout 1200 opencode run "$PROMPT" \
  --model "armature-gw/pr-swarm-verification" --agent build --auto --format json
```

## Behavior

When a session exceeds `OPENCODE_MAX_TURNS`:

1. A stop instruction is prepended to the system prompt telling the model to
   emit its findings immediately.
2. The session is interrupted on the next microtask boundary, giving the model
   **exactly one more turn** to produce output before exit.

This means a reviewer that hits the cap still emits partial findings rather
than getting cut off mid-stream with nothing.

## Comparison with `timeout`

| | `timeout 1200` | `OPENCODE_MAX_TURNS` |
|---|---|---|
| What it measures | Wall-clock time | Model calls (tool steps) |
| Predictable cost | No (network latency varies) | Yes (fixed per-call cost) |
| Reviewer output on hit | Truncated/empty file | Partial findings in final turn |
| Per-role tuning | Same for all | Per-spawn env var |

Use both: `timeout` catches network hangs, `max-turns` catches exploration
spirals. They guard different failure modes.