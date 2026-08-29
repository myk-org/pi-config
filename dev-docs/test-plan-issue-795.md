# Test plan for #795 queue inspect output

## Scope

Verify the registered `coms_queue_inspect` tool returns a tool-framework result whose visible text includes the preview ID and
body-free item metadata. The test must invoke the registered tool's `execute`, not only queue-recovery helpers.

## Cases

1. Start two in-process coms peers, queue an inbound message, and call the sender's registered `coms_queue_inspect` tool.
2. Assert the `execute` result's text includes `preview_id`, item ID, sender, target, age, FIFO position, and delivery state.
3. Assert `details` carries the preview contract and neither the visible result nor details contains the queued message body.
4. Use the preview ID returned by `execute` with `coms_queue_clear` and assert the clear succeeds.
5. Pass an unknown preview ID to `coms_queue_clear` and assert it returns `invalid_preview` without clearing messages.
6. Reject `coms_send.clearPrevious` and inspect afterward to prove its queued message remains intact.
7. Generate more than the per-session preview limit and verify the oldest token is invalid; this exercises bounded preview lifecycle pruning/eviction.
8. Exercise `previewRpcQueue` directly for unavailable, malformed, provider exception, steering, follow-up, and body-free output.
9. Require an issued RPC preview token for `clearRpcQueue`; cover missing, fabricated, reused, stale, malformed, exception, and
   valid-token outcomes while asserting rejected tokens never call `clearQueue`.
10. Preserve partial local recovery outcomes through an atomic stale-preview clear: no queue entry may be removed when the preview snapshot is stale.

## Commands

- Focused:

  ```sh
  PI_SUBAGENT_CHILD=0 NODE_PATH=/home/myakove/git/pi-config/node_modules/@earendil-works/pi-coding-agent/node_modules \
    node --test --test-force-exit --import tsx tests/node/coms/queue-inspect-tool.test.ts
  ```

- Relevant coms suite:

  ```sh
  PI_SUBAGENT_CHILD=0 NODE_PATH=/home/myakove/git/pi-config/node_modules/@earendil-works/pi-coding-agent/node_modules \
    node --test --test-force-exit --import tsx tests/node/coms/*.test.ts
  ```

- Required Node checks:

  ```sh
  PI_SUBAGENT_CHILD=0 NODE_PATH=/home/myakove/git/pi-config/node_modules/@earendil-works/pi-coding-agent/node_modules \
    node --test --test-force-exit --import tsx tests/node/**/*.test.ts
  ```

- Required formatting and lint checks: `prek run --all-files`
