"""Basic single-shot AI call.

The simplest way to use pi-sidecar-client. Creates a session,
sends one prompt, and cleans up automatically.

Requires: a running pi-sidecar on http://127.0.0.1:9100
"""

import asyncio

from pi_sidecar_client import call_ai_once


async def main() -> None:
    result = await call_ai_once(
        "What are the three laws of robotics?",
        ai_provider="gemini",
        ai_model="gemini-2.5-flash",
        system_prompt="You are a helpful assistant. Be concise.",
    )

    if result.success:
        print(result.text)
        if result.usage is not None:
            print(f"\nTokens: in={result.usage.input_tokens} out={result.usage.output_tokens}")
    else:
        print(f"Error: {result.text}")


if __name__ == "__main__":
    asyncio.run(main())
