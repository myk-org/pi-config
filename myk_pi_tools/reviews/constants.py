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

# Qodo finding-type phrases (title-cased as they appear in review bodies) mapped
# to sticky finding types. Shared by fetch (sticky typing) and address (thread
# body-marker typing) so a thread/sticky pair of one finding always agrees.
QODO_TYPE_MAP = {
    "Bug": "qodo_bug",
    "Rule violation": "qodo_rule_violation",
    "Requirement gap": "qodo_requirement_gap",
    "UX issue": "qodo_ux_issue",
    "Cross-repo conflict": "qodo_cross_repo",
}
