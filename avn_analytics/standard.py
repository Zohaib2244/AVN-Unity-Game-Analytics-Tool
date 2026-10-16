"""The AVN events standard and the prompt that sets it up in a game with an AI agent.

The files in `events_standard/` are the only copy: the website hands them out as they are, with
the prompt's tiers line set to what the person picked.
"""

import io
import json
import re
import zipfile
from functools import cache
from pathlib import Path

FOLDER = Path(__file__).parent / "events_standard"
SPEC = "standard.spec.json"
GUIDE = "STANDARD.md"
PROMPT = "AGENT_PROMPT.md"
TIERS = ("core", "standard", "extended")
TIERS_LINE = re.compile(r"^Tiers to implement: .*$", re.M)


@cache
def _read(name):
    return (FOLDER / name).read_text(encoding="utf-8")


def spec():
    return json.loads(_read(SPEC))


def tiers_for(chosen):
    """Core always, then the chosen tiers in the standard's order. Unknown names are an error."""
    unknown = sorted(set(chosen) - set(TIERS))
    if unknown:
        raise ValueError(f"Unknown tier: {', '.join(unknown)}")
    return [tier for tier in TIERS if tier == "core" or tier in chosen]


def prompt(chosen):
    """The text between the two `---` lines of AGENT_PROMPT.md, with the tiers filled in."""
    body = _read(PROMPT).split("\n---\n")[1].strip()
    line = f"Tiers to implement: **{', '.join(tiers_for(chosen))}**."
    return TIERS_LINE.sub(line, body, count=1) + "\n"


def summary(chosen):
    tiers = tiers_for(chosen)
    data = spec()
    events = [
        {"name": name, "tier": entry["tier"], "states": list(entry["states"])}
        for name, entry in data["events"].items()
        if entry["tier"] in tiers
    ]
    return {"version": data["version"], "tiers": tiers, "events": events, "prompt": prompt(chosen)}


def bundle(chosen):
    """A ZIP to unpack in the root of the game project."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(PROMPT, prompt(chosen))
        archive.writestr(SPEC, _read(SPEC))
        archive.writestr(GUIDE, _read(GUIDE))
    return buffer.getvalue()
