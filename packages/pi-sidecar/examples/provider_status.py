"""Provider status — diagnose why a provider isn't showing models.

Get registration, model count, and auth status for a single provider.
Useful when a provider you expect to see in list_models() is missing or
empty — this surfaces the registration/auth state behind that gap.

`get_model_provider_status()` lives on `SidecarClient` (via
`get_sidecar_client()`), not as a module-level helper like `list_models()`.

Unregistered providers return HTTP 404 (with a JSON body); this example
prints that diagnostic instead of crashing.

Requires: a running pi-sidecar on http://127.0.0.1:9100
"""

import asyncio

import httpx

from pi_sidecar_client import get_sidecar_client


async def main() -> None:
    client = get_sidecar_client()

    for provider in ("google", "acpx-cursor", "cli-cursor"):
        try:
            status = await client.get_model_provider_status(provider)
            print(f"{provider}:")
            print(f"  registered : {status['registered']}")
            print(f"  modelCount : {status['modelCount']}")
            # Do not print authStatus/authCheck — they may contain sensitive
            # auth configuration (see SidecarClient.get_model_provider_status).
            print(f"  authStatus : {'present' if status.get('authStatus') is not None else 'null'}")
            print(f"  authCheck  : {'present' if status.get('authCheck') is not None else 'null'}")
        except httpx.HTTPStatusError as exc:
            body = {}
            try:
                body = exc.response.json()
            except Exception:
                body = {"raw": exc.response.text}
            print(f"{provider}: HTTP {exc.response.status_code} — {body}")
        print()


if __name__ == "__main__":
    asyncio.run(main())
