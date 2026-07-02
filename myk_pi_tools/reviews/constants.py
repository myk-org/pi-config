"""Shared constants for the reviews subsystem."""

# Qodo sticky finding types (NOT qodo_reply which is informational)
QODO_STICKY_TYPES = frozenset({
    "qodo_bug",
    "qodo_rule_violation",
    "qodo_requirement_gap",
    "qodo_finding",
    "qodo_ux_issue",
    "qodo_cross_repo",
})
