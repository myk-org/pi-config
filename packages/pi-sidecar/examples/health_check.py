"""Health check — verify sidecar is running and ready.

Use check_sidecar_available() to verify the sidecar is reachable
before sending prompts. Distinguishes between ready, starting, and down.

Requires: a running pi-sidecar on http://127.0.0.1:9100
"""

import asyncio

from pi_sidecar_client import check_sidecar_available


async def main() -> None:
    available, message = await check_sidecar_available()

    if available:
        print(f"✅ {message}")
    else:
        print(f"❌ {message}")


if __name__ == "__main__":
    asyncio.run(main())
