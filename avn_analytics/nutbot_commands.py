"""NutBot's skills: slash commands that expand into a prepared set of instructions.

Each skill is a markdown file in nutbot_skills/ with a small header (name, summary, args). Sending
"/level-review 12" puts the file's text, with the arguments filled in, in front of the agent while
the chat keeps the line the person typed. core.md has no header: it is the analysis guidance that
is part of every system prompt.
"""

import re
from pathlib import Path

SKILLS = Path(__file__).parent / "nutbot_skills"
COMMAND = re.compile(r"^/([a-z][a-z-]{1,30})(?:\s+(.*))?$", re.S)


def load():
    skills = {}
    for path in sorted(SKILLS.glob("*.md")):
        header, _, body = path.read_text(encoding="utf-8").partition("\n---\n")
        if not header.startswith("---\n"):
            continue
        fields = dict(
            line.split(": ", 1)
            for line in header.removeprefix("---\n").splitlines()
            if ": " in line
        )
        if fields.get("name"):
            skills[fields["name"]] = {
                "name": fields["name"],
                "summary": fields.get("summary", ""),
                "args": fields.get("args", ""),
                "body": body.strip(),
            }
    return skills


def listing():
    return [{key: skill[key] for key in ("name", "summary", "args")} for skill in load().values()]


def expand(message, skills=None):
    """(text for the agent, skill name) for "/name args"; (message, None) for anything else."""
    found = COMMAND.match(message.strip())
    skills = load() if skills is None else skills
    if not found or found.group(1) not in skills:
        return message, None
    skill, args = skills[found.group(1)], (found.group(2) or "").strip()
    default = (
        "the levels that lose the most players"
        if "level" in skill["name"]
        else "what the page is showing"
    )
    text = skill["body"].replace("{args_or_default}", args or default)
    return f"{text}\n\nThe person typed: {message.strip()}", skill["name"]
