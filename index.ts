import { Plugin } from "@opencode/plugin"

/**
 * opencode-max-turns
 *
 * Enforces a hard turn limit on sessions. When a session exceeds the configured
 * maximum number of model calls, the plugin interrupts it — giving the model
 * one final turn to emit output before the session ends.
 *
 * ## Configuration
 *
 * Set `OPENCODE_MAX_TURNS` to the turn limit. The plugin is a no-op when the
 * variable is unset or zero.
 *
 * ```bash
 * export OPENCODE_MAX_TURNS=20
 * opencode run "Review this PR" --agent build --auto --format json
 * ```
 *
 * ## Per-role budgets (pr-swarm pattern)
 *
 * Each reviewer persona gets its own turn budget by setting the variable
 * per-spawn:
 *
 * ```bash
 * # security reviewer — 20 turns
 * export OPENCODE_MAX_TURNS=20
 * timeout 1200 opencode run "$PROMPT_SEC" --model "armature-gw/pr-swarm-security" --agent build --auto --format json
 *
 * # verification reviewer — 16 turns
 * export OPENCODE_MAX_TURNS=16
 * timeout 1200 opencode run "$PROMPT_VER" --model "armature-gw/pr-swarm-verification" --agent build --auto --format json
 * ```
 *
 * ## How it works
 *
 * The plugin hooks `session.context`, which fires before every model call in
 * the agent loop. It counts invocations per session. When the count exceeds
 * `OPENCODE_MAX_TURNS`, it:
 *
 * 1. Prepends a stop instruction to the system prompt so the model knows to
 *    emit its findings now rather than mid-exploration.
 * 2. Schedules an interrupt on the next microtask boundary, so the model gets
 *    exactly one more turn to produce output before the session ends.
 *
 * The result: a reviewer that hits max_turns still emits partial findings
 * rather than getting cut off mid-stream with nothing.
 *
 * ## Cleanup
 *
 * Session turn counters are removed when the session is deleted, preventing
 * memory leaks in long-running server processes.
 */

const MAX_TURNS = (() => {
  const raw = process.env.OPENCODE_MAX_TURNS
  if (!raw) return 0
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
})()

export default Plugin.define({
  id: "max-turns",
  async setup(ctx) {
    if (!MAX_TURNS) return

    const counts = new Map<string, number>()

    const registration = await ctx.session.hook("context", async (event) => {
      const n = (counts.get(event.sessionID) ?? 0) + 1
      counts.set(event.sessionID, n)

      if (n > MAX_TURNS) {
        event.system.unshift({
          type: "text",
          text:
            `!!! MAX_TURNS (${MAX_TURNS}) REACHED !!!\n` +
            `You have exceeded the turn budget. You have exactly ONE more response\n` +
            `to emit your findings before the session is interrupted. Output your\n` +
            `STRUCTURED_FINDINGS block NOW — do NOT explore further, do NOT run\n` +
            `additional tools. Partial findings are acceptable; silence is not.\n`,
        })
        // Schedule the interrupt after the hook returns so this model call
        // completes and the model has one final turn to emit output.
        queueMicrotask(() => {
          ctx.session.interrupt({ sessionID: event.sessionID, continue: false })
        })
      }
    })

    // Clean up stale counters when sessions end
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.deleted") {
          counts.delete(event.properties.sessionID)
        }
      }
    })()

    return () => {
      controller.abort()
      registration.dispose()
    }
  },
})