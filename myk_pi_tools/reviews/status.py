"""Review handler status — query reviews DB and display all comments for current PR.

Outputs:
1. TUI table to stdout
2. HTML file saved to /tmp/pi-work/<project>/review-status.html
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
from html import escape
from pathlib import Path


def log(message: str) -> None:
    print(message, file=sys.stderr)


def get_project_root() -> Path:
    """Get main project root (resolves through git worktrees)."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            log(f"Error: git rev-parse failed: {result.stderr.strip()}")
            sys.exit(1)
        git_common = Path(result.stdout.strip()).resolve()
        return git_common.parent
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log(f"Error: {e}")
        sys.exit(1)


def get_current_pr() -> dict | None:
    """Get current PR number and branch from git + gh CLI."""
    try:
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if branch.returncode != 0:
            return None
        branch_name = branch.stdout.strip()
        if not branch_name or branch_name == "main":
            return None

        pr_info = subprocess.run(
            ["gh", "pr", "view", "--json", "number,title,headRefName"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if pr_info.returncode != 0:
            return None
        data = json.loads(pr_info.stdout)
        return {
            "number": data.get("number"),
            "title": data.get("title", ""),
            "branch": data.get("headRefName", branch_name),
        }
    except Exception:
        return None


def query_comments(db_path: Path, pr_number: int) -> list[dict]:
    """Query all comments for a PR from the reviews DB."""
    if not db_path.exists():
        return []

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute(
            """
            SELECT c.source, c.path, c.line, c.body, c.status, c.reply,
                   c.priority, c.skip_reason, c.type, c.quality_label,
                   r.commit_sha, r.created_at
            FROM comments c
            JOIN reviews r ON c.review_id = r.id
            WHERE r.pr_number = ?
            ORDER BY r.created_at ASC, c.id ASC
            """,
            (pr_number,),
        )
        return [dict(row) for row in cursor.fetchall()]
    except sqlite3.Error as e:
        log(f"Database error: {e}")
        return []
    finally:
        conn.close()


def extract_summary(body: str, max_len: int = 60) -> str:
    """Extract a short summary from the comment body."""
    if not body:
        return ""
    # Try to get the first meaningful line (skip HTML tags, empty lines)
    for line in body.split("\n"):
        line = line.strip()
        if not line or line.startswith("<") or line.startswith("#"):
            continue
        # Strip HTML tags and markdown bold/italic
        line = re.sub(r"<[^>]+>", "", line)
        clean = line.replace("**", "").replace("*", "").replace("`", "")
        # Strip leading numbering like "1\." or "2."
        if clean and clean[0].isdigit() and "." in clean[:4]:
            clean = clean.split(".", 1)[1].strip()
        if clean:
            return clean[:max_len] + ("..." if len(clean) > max_len else "")
    return body[:max_len].replace("\n", " ") + ("..." if len(body) > max_len else "")


def deduplicate_comments(comments: list[dict]) -> list[dict]:
    """Deduplicate comments — keep latest status for same path+line+source+summary."""
    seen: dict[str, dict] = {}
    for c in comments:
        # Normalize summary for dedup: strip HTML, lowercase, first 30 chars
        raw = re.sub(r"<[^>]+>", "", extract_summary(c["body"], 50)).lower().strip()
        key = f"{c['source']}:{c['path']}:{c['line']}:{raw[:30]}"
        seen[key] = c  # Last one wins (latest cycle)
    return list(seen.values())


def format_tui_table(comments: list[dict], pr_info: dict) -> str:
    """Format comments as a TUI table."""
    lines = [f"PR #{pr_info['number']} ({pr_info['branch']}) — {pr_info['title']}"]
    lines.append("")

    if not comments:
        lines.append("No review comments stored.")
        return "\n".join(lines)

    # Build table
    headers = ["#", "Source", "File", "Line", "Summary", "Status", "Reply"]
    rows = []
    for i, c in enumerate(comments, 1):
        summary = extract_summary(c["body"])
        reply = (c.get("reply") or c.get("skip_reason") or "")[:50]
        if reply and len(c.get("reply") or c.get("skip_reason") or "") > 50:
            reply += "..."
        rows.append([
            str(i),
            c["source"],
            (c.get("path") or "").split("/")[-1],  # basename only
            str(c.get("line") or ""),
            summary,
            c.get("status") or "pending",
            reply,
        ])

    # Calculate column widths
    widths = [len(h) for h in headers]
    for row in rows:
        for j, cell in enumerate(row):
            widths[j] = max(widths[j], len(cell))

    # Cap widths
    widths[4] = min(widths[4], 50)  # Summary
    widths[6] = min(widths[6], 50)  # Reply

    def fmt_row(cells: list[str]) -> str:
        parts = []
        for j, cell in enumerate(cells):
            w = widths[j]
            parts.append(cell[:w].ljust(w))
        return "| " + " | ".join(parts) + " |"

    lines.append(fmt_row(headers))
    lines.append("|" + "|".join("-" * (w + 2) for w in widths) + "|")
    for row in rows:
        lines.append(fmt_row(row))

    # Summary counts
    lines.append("")
    status_counts: dict[str, int] = {}
    for c in comments:
        s = c.get("status") or "pending"
        status_counts[s] = status_counts.get(s, 0) + 1
    parts = [f"{v} {k}" for k, v in sorted(status_counts.items())]
    lines.append(f"Total: {len(comments)} comments — {', '.join(parts)}")

    return "\n".join(lines)


def generate_html(comments: list[dict], pr_info: dict) -> str:
    """Generate HTML report with styled table."""
    status_colors = {
        "addressed": "#d4edda",
        "skipped": "#fff3cd",
        "not_addressed": "#f8d7da",
        "pending": "#e2e3e5",
    }

    rows_html = ""
    for i, c in enumerate(comments, 1):
        summary = escape(extract_summary(c["body"], 80))
        reply = escape((c.get("reply") or c.get("skip_reason") or "")[:100])
        status = c.get("status") or "pending"
        bg = status_colors.get(status, "#e2e3e5")
        path = escape(c.get("path") or "")
        rows_html += f"""
        <tr>
            <td>{i}</td>
            <td>{escape(c["source"])}</td>
            <td title="{path}">{escape(path.split("/")[-1])}</td>
            <td>{c.get("line") or ""}</td>
            <td>{summary}</td>
            <td style="background-color: {bg}; font-weight: bold;">{escape(status)}</td>
            <td>{reply}</td>
        </tr>"""

    status_counts: dict[str, int] = {}
    for c in comments:
        s = c.get("status") or "pending"
        status_counts[s] = status_counts.get(s, 0) + 1
    summary_parts = [f"{v} {k}" for k, v in sorted(status_counts.items())]

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Review Status — PR #{pr_info["number"]}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont,
            'Segoe UI', Roboto, sans-serif; margin: 2rem;
            background: #f8f9fa; color: #212529; }}
        h1 {{ font-size: 1.5rem; margin-bottom: 0.25rem; }}
        h2 {{ font-size: 1rem; color: #6c757d; font-weight: normal; margin-top: 0; }}
        table {{ border-collapse: collapse; width: 100%; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }}
        th, td {{ padding: 8px 12px; text-align: left; border: 1px solid #dee2e6; font-size: 0.875rem; }}
        th {{ background: #343a40; color: white; font-weight: 600; }}
        tr:hover {{ background: #f1f3f5; }}
        .summary {{ margin-top: 1rem; color: #6c757d; }}
    </style>
</head>
<body>
    <h1>PR #{pr_info["number"]} — {escape(pr_info["title"])}</h1>
    <h2>{escape(pr_info["branch"])}</h2>
    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>Source</th>
                <th>File</th>
                <th>Line</th>
                <th>Summary</th>
                <th>Status</th>
                <th>Reply</th>
            </tr>
        </thead>
        <tbody>
            {rows_html}
        </tbody>
    </table>
    <p class="summary">Total: {len(comments)} comments — {", ".join(summary_parts)}</p>
</body>
</html>"""


def save_html(html: str, project_name: str) -> Path:
    """Save HTML to temp directory and return path."""
    tmp_dir = Path("/tmp/pi-work") / project_name
    tmp_dir.mkdir(parents=True, exist_ok=True)
    html_path = tmp_dir / "review-status.html"
    html_path.write_text(html, encoding="utf-8")
    return html_path


def run() -> None:
    """Main entry point for reviews status command."""
    project_root = get_project_root()
    project_name = project_root.name
    db_path = project_root / ".pi" / "data" / "reviews.db"

    if not db_path.exists():
        print("No reviews database found. Run /review-handler first.")
        sys.exit(0)

    pr_info = get_current_pr()
    if not pr_info or not pr_info.get("number"):
        log("Error: Could not detect current PR. Check out a branch with an open PR.")
        sys.exit(1)

    comments = query_comments(db_path, pr_info["number"])
    comments = deduplicate_comments(comments)

    # TUI output
    print(format_tui_table(comments, pr_info))

    # HTML output
    html = generate_html(comments, pr_info)
    html_path = save_html(html, project_name)

    # Check if in container
    in_container = os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")

    if in_container:
        # Serve via httpd
        httpd = project_root / "scripts" / "httpd.py"
        if httpd.exists():
            try:
                port_result = subprocess.run(
                    ["uv", "run", "python3", str(httpd), "--find-port"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                port = port_result.stdout.strip()
                subprocess.Popen(
                    ["uv", "run", "python3", str(httpd), "--port", port, "--dir", str(html_path.parent)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                print(f"\nHTML report: http://localhost:{port}/review-status.html")
            except Exception as e:
                print(f"\nHTML report saved: {html_path}")
                log(f"Warning: Could not start HTTP server: {e}")
        else:
            print(f"\nHTML report saved: {html_path}")
    else:
        print(f"\nHTML report saved: {html_path}")


if __name__ == "__main__":
    run()
