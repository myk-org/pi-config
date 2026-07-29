"""Usage tracking — record token usage with a custom callback.

Register a callback for recording token usage. Call result.record_usage()
after each AI call to record the usage data.
Useful for cost monitoring, billing, or analytics.

Requires: a running pi-sidecar on http://127.0.0.1:9100
"""

import asyncio

from pi_sidecar_client import AIResult, call_ai_once, set_usage_recorder

# Storage for usage records
usage_log: list[dict] = []


async def my_usage_recorder(
    *,
    request_id: str,
    result: AIResult,
    call_type: str,
    prompt_chars: int,  # noqa: ARG001
    ai_provider: str,
    ai_model: str,
) -> None:
    """Custom callback that stores usage data."""
    record = {
        "request_id": request_id,
        "call_type": call_type,
        "provider": ai_provider,
        "model": ai_model,
        "input_tokens": result.usage.input_tokens if result.usage else 0,
        "output_tokens": result.usage.output_tokens if result.usage else 0,
        "cost_usd": result.usage.cost_usd if result.usage else None,
    }
    usage_log.append(record)
    print(f"  [tracked] {call_type}: {record['input_tokens']}in/{record['output_tokens']}out")


async def main() -> None:
    # Register the callback once at startup; usage is recorded manually
    # by calling result.record_usage() after each AI call.
    set_usage_recorder(my_usage_recorder)

    # Make some AI calls
    result = await call_ai_once(
        "What is the speed of light?",
        ai_provider="gemini",
        ai_model="gemini-2.5-flash",
    )
    # Record usage for this call
    await result.record_usage(
        request_id="req-001",
        call_type="question",
        ai_provider="gemini",
        ai_model="gemini-2.5-flash",
    )

    print(f"\nAnswer: {result.text}")
    print(f"\nUsage log: {len(usage_log)} entries")
    for entry in usage_log:
        print(f"  {entry}")


if __name__ == "__main__":
    asyncio.run(main())
