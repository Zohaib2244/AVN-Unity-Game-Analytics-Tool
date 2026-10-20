"""The AVN events standard and the prompt that sets it up in a game with an AI agent.

The files in `avn_events_standard/` are the only copy: the website hands them out as they are, with
the prompt's tiers line set to what the person picked.
"""

import io
import json
import re
import zipfile
from functools import cache
from pathlib import Path

FOLDER = Path(__file__).parent / "avn_events_standard"
SPEC = "avn_events_standard.json"
GUIDE = "avn_events_standard.md"
PROMPT = "AGENT_PROMPT.md"
TIERS = ("core", "standard", "extended", "custom")
TIERS_LINE = re.compile(r"^Tiers to implement: .*$", re.M)


@cache
def _read(name):
    return (FOLDER / name).read_text(encoding="utf-8")


def _spec_entry(body):
    """A custom event in spec format, from the editor's lists."""
    states = {}
    for state in body["states"]:
        params = {}
        for param in state["params"]:
            item = {"type": param["type"], "required": param["required"]}
            if param["note"]:
                item["note"] = param["note"]
            if param["values"]:
                item["enum"] = list(param["values"])
            params[param["key"]] = item
        states[state["name"]] = {"trigger": state["trigger"], "params": params}
    return {"tier": "custom", "purpose": body["purpose"], "states": states, "shared_params": {}}


def spec(custom=None):
    """The built-in standard, plus the custom events ({name: stored body}) as the custom tier."""
    data = json.loads(_read(SPEC))
    if custom:
        for name, body in custom.items():
            data["events"][name] = _spec_entry(body)
        data["tiers"]["custom"] = f"{', '.join(custom)}. Added on this installation."
    return data


def guide(custom=None):
    """avn_events_standard.md, with a section per custom event so it matches the spec."""
    text = _read(GUIDE)
    if not custom:
        return text
    lines = [
        "",
        "## Custom events",
        "",
        "Added on this installation, on top of the standard above.",
        "",
    ]
    for name, body in custom.items():
        lines += [f"### {name} (custom)", "", body["purpose"] or "", ""]
        for state in body["states"]:
            lines += [f"#### `{state['name']}`", "", state["trigger"] or "", ""]
            if state["params"]:
                lines += ["| Key | Type | Required | Note |", "|---|---|---|---|"]
                for param in state["params"]:
                    note = param["note"]
                    if param["values"]:
                        note = f"{note} One of: {', '.join(param['values'])}.".strip()
                    required = "yes" if param["required"] else "no"
                    lines.append(f"| `{param['key']}` | {param['type']} | {required} | {note} |")
                lines.append("")
    return text.rstrip("\n") + "\n" + "\n".join(lines)


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


def summary(chosen, custom=None):
    tiers = tiers_for(chosen)
    data = spec(custom)
    events = [
        {"name": name, "tier": entry["tier"], "states": list(entry["states"])}
        for name, entry in data["events"].items()
        if entry["tier"] in tiers
    ]
    return {"version": data["version"], "tiers": tiers, "events": events, "prompt": prompt(chosen)}


def bundle(chosen, custom=None):
    """A ZIP to unpack in the root of the game project."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(PROMPT, prompt(chosen))
        archive.writestr(SPEC, json.dumps(spec(custom), indent=2) + "\n" if custom else _read(SPEC))
        archive.writestr(GUIDE, guide(custom))
    return buffer.getvalue()
