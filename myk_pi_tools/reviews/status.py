"""Review handler status — query reviews DB and display all comments for current PR.

Outputs:
1. TUI table to stdout
2. HTML file saved to /tmp/pi-work/<project>/review-status-<pr>.html
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
from html import escape
from pathlib import Path
from urllib.parse import quote

from bs4 import BeautifulSoup


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


def get_pr_repo_info(db_path: Path, pr_number: int) -> tuple[str, str]:
    """Get owner/repo for a PR from the reviews DB."""
    if not db_path.exists():
        return ("", "")
    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT owner, repo FROM reviews WHERE pr_number = ? LIMIT 1",
            (pr_number,),
        ).fetchone()
        return (row[0], row[1]) if row else ("", "")
    except sqlite3.Error:
        return ("", "")
    finally:
        conn.close()


def extract_summary(body: str, max_len: int = 60) -> str:
    """Extract a short summary from the comment body."""
    if not body:
        return ""
    # Strip ALL HTML tags from entire body first
    cleaned_body = BeautifulSoup(body, "html.parser").get_text() if re.search(r"<[a-zA-Z/]", body) else body
    # Try to get the first meaningful line
    for line in cleaned_body.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Strip markdown bold/italic/code
        clean = line.replace("**", "").replace("*", "").replace("`", "")
        # Strip leading numbering like "1\." or "2."
        if clean and clean[0].isdigit() and "." in clean[:4]:
            clean = clean.split(".", 1)[1].strip()
        # Strip escaped backslashes from markdown
        clean = clean.replace("\\", "")
        if clean:
            return clean[:max_len] + ("..." if len(clean) > max_len else "")
    return cleaned_body[:max_len].replace("\n", " ").strip() + ("..." if len(cleaned_body) > max_len else "")


def deduplicate_comments(comments: list[dict]) -> list[dict]:
    """Deduplicate comments — keep latest status for same source+path+summary.

    Line numbers are excluded from the key because they shift between commits.
    Summary is normalized: stripped, lowercased, whitespace collapsed, first 40 chars.
    """
    seen: dict[str, dict] = {}
    for c in comments:
        raw = extract_summary(c["body"], 60).lower().strip()
        # Strip emoji badges, quality labels, and Qodo type markers
        raw = re.sub(r"[\U0001f300-\U0001f9ff\u2600-\u27bf\u2700-\u27bf≡☼➹📎]", "", raw)
        raw = re.sub(
            r"\b(bug|rule violation|requirement gap|correctness|reliability|maintainability|performance)\b", "", raw
        )
        # Collapse whitespace and take first 40 chars for stable matching
        normalized = re.sub(r"\s+", " ", raw).strip()[:80]
        key = f"{c['source']}:{c.get('path', '')}:{normalized}"
        seen[key] = c  # Last one wins (latest cycle)
    return list(seen.values())


def format_tui_table(comments: list[dict], pr_info: dict) -> str:
    """Format comments as a clean TUI table."""
    lines = [f"PR #{pr_info['number']} ({pr_info['branch']}) — {pr_info['title']}"]
    lines.append("")

    if not comments:
        lines.append("No review comments found for this PR.")
        return "\n".join(lines)

    # Fixed column widths for clean alignment
    col_widths = {
        "#": 4,
        "Source": 10,
        "File": 25,
        "Line": 5,
        "Summary": 40,
        "Status": 15,
        "Reply": 80,
    }

    def pad(text: str, width: int) -> str:
        """Pad/truncate text to exact width."""
        if len(text) > width:
            return text[: width - 1] + "…"
        return text.ljust(width)

    # Header
    header = (
        f"  {'#':<{col_widths['#']}} "
        f"{'Source':<{col_widths['Source']}} "
        f"{'File':<{col_widths['File']}} "
        f"{'Line':<{col_widths['Line']}} "
        f"{'Summary':<{col_widths['Summary']}} "
        f"{'Status':<{col_widths['Status']}} "
        f"{'Reply':<{col_widths['Reply']}}"
    )
    separator = "  " + "─" * (sum(col_widths.values()) + len(col_widths) - 1)

    lines.append(header)
    lines.append(separator)

    # Rows
    for i, c in enumerate(comments, 1):
        summary = extract_summary(c["body"], col_widths["Summary"])
        status = c.get("status") or "pending"
        is_sticky = (c.get("type") or "").startswith("qodo_")
        if is_sticky:
            status = f"{status} \U0001f4cc"
        file_name = (c.get("path") or "").split("/")[-1]
        line_num = str(c.get("line") or "")

        reply = (c.get("reply") or c.get("skip_reason") or "")[: col_widths["Reply"]]
        row = (
            f"  {pad(str(i), col_widths['#'])} "
            f"{pad(c['source'], col_widths['Source'])} "
            f"{pad(file_name, col_widths['File'])} "
            f"{pad(line_num, col_widths['Line'])} "
            f"{pad(summary, col_widths['Summary'])} "
            f"{pad(status, col_widths['Status'])} "
            f"{pad(reply, col_widths['Reply'])}"
        )
        lines.append(row)

    # Summary counts
    lines.append(separator)
    status_counts: dict[str, int] = {}
    for c in comments:
        s = c.get("status") or "pending"
        status_counts[s] = status_counts.get(s, 0) + 1
    parts = [f"{v} {k}" for k, v in sorted(status_counts.items())]
    lines.append(f"  Total: {len(comments)} — {', '.join(parts)}")

    return "\n".join(lines)


def generate_html(comments: list[dict], pr_info: dict) -> str:
    """Generate HTML report with styled table."""
    status_colors = {
        "addressed": "#1a3a2a",
        "skipped": "#3a3520",
        "not_addressed": "#3a1a1a",
        "pending": "#2a2a2a",
    }
    status_text_colors = {
        "addressed": "#3fb950",
        "skipped": "#d29922",
        "not_addressed": "#f85149",
        "pending": "#8b949e",
    }

    owner = pr_info.get("owner", "")
    repo = pr_info.get("repo", "")
    pr_url = (
        f"https://github.com/{quote(owner, safe='')}/{quote(repo, safe='')}/pull/{pr_info['number']}"
        if owner and repo
        else ""
    )
    pr_link = (
        f'<a href="{escape(pr_url)}" target="_blank" rel="noopener noreferrer"'
        f' style="color: #58a6ff; text-decoration: none;">PR #{pr_info["number"]}</a>'
        if pr_url
        else f"PR #{pr_info['number']}"
    )

    rows_html = ""
    for i, c in enumerate(comments, 1):
        summary = escape(extract_summary(c["body"], 80))
        raw_reply = c.get("reply") or c.get("skip_reason") or ""
        if len(raw_reply) > 200:
            reply = f"<details><summary>{escape(raw_reply[:150])}...</summary>{escape(raw_reply)}</details>"
        else:
            reply = escape(raw_reply)
        status = c.get("status") or "pending"
        is_sticky = (c.get("type") or "").startswith("qodo_")
        sticky_badge = ' <span title="Still in Qodo sticky comment">📌</span>' if is_sticky else ""
        bg = status_colors.get(status, "#e2e3e5")
        path = escape(c.get("path") or "")
        rows_html += f"""
        <tr>
            <td>{i}</td>
            <td>{escape(c["source"])}</td>
            <td title="{path}">{escape(path.split("/")[-1])}</td>
            <td>{c.get("line") or ""}</td>
            <td>{summary}</td>
            <td style="background-color: {bg}; font-weight: bold;
                color: {status_text_colors.get(status, "#c9d1d9")};">
                {escape(status)}{sticky_badge}</td>
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
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 2rem; background: #0d1117; color: #c9d1d9; }}
        h1 {{ font-size: 1.5rem; margin-bottom: 0.25rem; color: #f0f6fc; }}
        h2 {{ font-size: 1rem; color: #8b949e; font-weight: normal; margin-top: 0; }}
        table {{ border-collapse: collapse; width: 100%; background: #161b22;
            box-shadow: 0 2px 8px rgba(0,0,0,0.5); border-radius: 6px; overflow: hidden; }}
        th, td {{ padding: 10px 14px; text-align: left; border: 1px solid #30363d;
            font-size: 0.875rem; }}
        th {{ background: #21262d; color: #f0f6fc; font-weight: 600; }}
        tr:nth-child(even) {{ background: #1c2128; }}
        tr:hover {{ background: #272d36; }}
        .summary {{ margin-top: 1rem; color: #8b949e; }}
    </style>
</head>
<body>
    <h1>{pr_link} — {escape(pr_info["title"])}</h1>
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


def save_html(html: str, project_name: str, pr_number: int) -> Path:
    """Save HTML to temp directory and return path."""
    tmp_dir = Path("/tmp/pi-work") / project_name
    tmp_dir.mkdir(parents=True, exist_ok=True)
    html_path = tmp_dir / f"review-status-{pr_number}.html"
    html_path.write_text(html, encoding="utf-8")
    return html_path


def list_prs_from_db(db_path: Path) -> None:
    """List all PRs that have reviews stored in the database."""
    if not db_path.exists():
        print("No reviews database found.")
        return

    conn = sqlite3.connect(str(db_path))
    try:
        cursor = conn.execute(
            """
            SELECT r.pr_number,
                   COUNT(c.id) as total,
                   SUM(CASE WHEN c.status = 'addressed' THEN 1 ELSE 0 END) as addressed,
                   SUM(CASE WHEN c.status = 'skipped' THEN 1 ELSE 0 END) as skipped,
                   SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending,
                   MIN(r.created_at) as first_review,
                   MAX(r.created_at) as last_review
            FROM reviews r
            JOIN comments c ON c.review_id = r.id
            GROUP BY r.pr_number
            ORDER BY r.pr_number DESC
            """,
        )
        rows = cursor.fetchall()
    except sqlite3.Error as e:
        print(f"Database error: {e}")
        return
    finally:
        conn.close()

    if not rows:
        print("No reviews stored in the database.")
        return

    print("Available PRs in reviews database:\n")
    print(f"  {'PR':<8} {'Total':<8} {'Addressed':<11} {'Skipped':<9} {'Pending':<9} {'Last Review'}")
    print(f"  {'─' * 70}")
    for row in rows:
        pr, total, addressed, skipped, pending, _first, last = row
        last_short = (last or "")[:10]
        print(f"  #{pr:<7} {total:<8} {addressed:<11} {skipped:<9} {pending:<9} {last_short}")

    print("\nUse: myk-pi-tools reviews status --pr <number>")


def run(pr_number: int | None = None) -> None:
    """Main entry point for reviews status command."""
    project_root = get_project_root()
    project_name = project_root.name
    db_path = project_root / ".pi" / "data" / "reviews.db"

    if not db_path.exists():
        print("No reviews database found. Run /review-handler first.")
        sys.exit(0)

    if pr_number:
        # Explicit PR number — build minimal pr_info
        pr_info = {"number": pr_number, "title": f"PR #{pr_number}", "branch": ""}
        # Try to get title from gh CLI
        try:
            result = subprocess.run(
                ["gh", "pr", "view", str(pr_number), "--json", "title,headRefName"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                data = json.loads(result.stdout)
                pr_info["title"] = data.get("title", pr_info["title"])
                pr_info["branch"] = data.get("headRefName", "")
        except Exception:
            pass  # Keep minimal info
    else:
        detected = get_current_pr()
        if not detected or not detected.get("number"):
            # List all PRs in the DB
            list_prs_from_db(db_path)
            sys.exit(0)
        pr_info = detected

    pr_num = int(str(pr_info["number"]))
    owner, repo = get_pr_repo_info(db_path, pr_num)
    pr_info["owner"] = owner
    pr_info["repo"] = repo
    comments = deduplicate_comments(query_comments(db_path, pr_num))

    # HTML output
    html = generate_html(comments, pr_info)
    html_path = save_html(html, project_name, pr_num)

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
                if port_result.returncode != 0 or not port_result.stdout.strip():
                    print(f"\nHTML report saved: {html_path} — open in browser to view")
                    return
                port = port_result.stdout.strip()
                if not port.isdigit():
                    print(f"\nHTML report saved: {html_path} — open in browser to view")
                    return
                subprocess.Popen(
                    ["uv", "run", "python3", str(httpd), "--port", port, "--dir", str(html_path.parent)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                print(f"\nHTML report: http://localhost:{port}/{html_path.name}")
            except Exception as e:
                print(f"\nHTML report saved: {html_path} — open in browser to view")
                log(f"Warning: Could not start HTTP server: {e}")
        else:
            print(f"\nHTML report saved: {html_path} — open in browser to view")
    else:
        print(f"\nHTML report saved: {html_path} — open in browser to view")


if __name__ == "__main__":
    run()
