"""CodeRabbit CLI validation — checks cr is installed and authenticated."""

from __future__ import annotations

import json
import subprocess


def run_validate() -> int:
    """Check cr is installed and authenticated.

    Returns:
        0 if ready, 1 if not.
    """
    _CR_NOT_FOUND = "ERROR: cr CLI not found. Install: curl -fsSL https://cli.coderabbit.ai/install.sh | sh"

    # Check installed
    try:
        result = subprocess.run(["cr", "--version"], capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            print(_CR_NOT_FOUND)
            return 1
        version = result.stdout.strip()
    except FileNotFoundError:
        print(_CR_NOT_FOUND)
        return 1
    except subprocess.TimeoutExpired:
        print("ERROR: cr --version timed out")
        return 1

    # Check authenticated
    try:
        result = subprocess.run(["cr", "auth", "status", "--agent"], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            print(f"ERROR: cr auth status failed: {result.stderr.strip() or result.stdout.strip()}")
            return 1
        data = json.loads(result.stdout)
        if not data.get("authenticated"):
            print("ERROR: Not authenticated with CodeRabbit. Run: cr auth login")
            return 1
        org = data.get("currentOrg", {}).get("name", "unknown")
        print(f"OK: cr {version} | authenticated | org: {org}")
        return 0
    except json.JSONDecodeError as e:
        print(f"ERROR: Failed to parse auth status response: {e}")
        return 1
    except subprocess.TimeoutExpired:
        print("ERROR: cr auth status timed out")
        return 1
    except (subprocess.SubprocessError, OSError) as e:
        print(f"ERROR: Failed to check auth status: {e}")
        return 1
