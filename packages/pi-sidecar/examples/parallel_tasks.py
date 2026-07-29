"""Parallel AI calls with concurrency limiting.

Run multiple AI calls simultaneously while capping the number
of concurrent requests to avoid overwhelming the sidecar.

Requires: a running pi-sidecar on http://127.0.0.1:9100
"""

import asyncio

from pi_sidecar_client import call_ai_once, run_parallel_with_limit


async def analyze(item: str) -> str:
    """Analyze a single item."""
    result = await call_ai_once(
        f"In one sentence, what is {item}?",
        ai_provider="gemini",
        ai_model="gemini-2.5-flash",
        system_prompt="Answer in exactly one sentence.",
    )
    return f"{item}: {result.text}" if result.success else f"{item}: ERROR - {result.text}"


async def main() -> None:
    items = ["Python", "Kubernetes", "WebAssembly", "GraphQL", "Rust"]

    # Run all analyses with max 3 concurrent requests
    results = await run_parallel_with_limit(
        [analyze(item) for item in items],
        max_concurrency=3,
    )

    for result in results:
        if isinstance(result, Exception):
            print(f"Failed: {result}")
        else:
            print(result)


if __name__ == "__main__":
    asyncio.run(main())
