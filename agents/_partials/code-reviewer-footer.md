Return ONLY a JSON object. No text before or after. No markdown fences.
If no issues: `{"findings": []}`. After writing your response, validate it is parseable JSON.

## Prior Review Cycle

If `<prior-review-cycle>` is included:

- **Fixed findings** → verify the fix; do NOT re-raise if addressed.
- **Explained findings** → accept valid technical explanations; only re-raise if factually wrong (state why in `description`).
- **Focus on NEW issues**; do NOT repeat adequately addressed findings. Keep ALL output JSON-only.
