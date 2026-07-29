"""Multi-turn conversation with session reuse.

Shows how to maintain conversation context across multiple prompts
by reusing the session_id returned from call_ai().

Requires: a running pi-sidecar on http://127.0.0.1:9100
"""

import asyncio

from pi_sidecar_client import call_ai, get_sidecar_client


async def main() -> None:
    session_id = None
    try:
        # First message — creates a new session
        result = await call_ai(
            "I'm building a REST API in Python. What framework should I use?",
            ai_provider="gemini",
            ai_model="gemini-2.5-flash",
            system_prompt="You are a senior Python developer. Be concise.",
        )
        session_id = result.session_id  # Capture before checking success
        if not result.success:
            print(f"Error: {result.text}")
            return

        print(f"AI: {result.text}\n")

        # Follow-up — reuses the same session (conversation context preserved)
        result = await call_ai(
            "Show me a minimal example with that framework.",
            ai_provider="gemini",
            ai_model="gemini-2.5-flash",
            session_id=session_id,
        )
        session_id = result.session_id  # Update in case of cleanup failure
        if not result.success:
            print(f"Error: {result.text}")
            return

        print(f"AI: {result.text}")
    finally:
        client = get_sidecar_client()
        # Clean up the session when done
        if session_id:
            try:
                await client.delete_session(session_id)
                print("\nSession cleaned up.")
            except Exception:
                print(f"\nWarning: failed to clean up session {session_id}")
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
