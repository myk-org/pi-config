"""Platform abstraction layer for GitHub and GitLab.

Provides a common interface (Platform ABC) so all business logic
is platform-agnostic. The only files that know GitHub vs GitLab
exists are inside this package.
"""

from myk_pi_tools.platform.base import (
    ChangedFile,
    Platform,
    PRMetadata,
    ReviewThread,
)
from myk_pi_tools.platform.detect import detect_platform

__all__ = [
    "ChangedFile",
    "Platform",
    "PRMetadata",
    "ReviewThread",
    "detect_platform",
]
