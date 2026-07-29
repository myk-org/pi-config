"""List available AI models.

Discover what models are available, optionally filtered by provider.

Requires: a running pi-sidecar on http://127.0.0.1:9100
"""

import asyncio

from pi_sidecar_client import list_models


async def main() -> None:
    # List all models
    all_models = await list_models()
    print(f"Total models available: {len(all_models)}\n")

    # Group by provider
    providers: dict[str, list] = {}
    for m in all_models:
        providers.setdefault(m["provider"], []).append(m)

    for provider, models in sorted(providers.items()):
        print(f"{provider} ({len(models)} models):")
        for m in models[:3]:  # Show first 3 per provider
            print(f"  - {m['id']}: {m['name']}")
        if len(models) > 3:
            print(f"  ... and {len(models) - 3} more")
        print()

    # Filter by provider
    gemini_models = await list_models(provider="gemini")
    print(f"Gemini models: {len(gemini_models)}")


if __name__ == "__main__":
    asyncio.run(main())
