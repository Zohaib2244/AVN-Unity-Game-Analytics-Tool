"""Opt-in mobile-device specification lookup through Wikipedia's public API."""

import json
import re
from functools import lru_cache
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from .insights import PLAYER

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
MAX_RESPONSE_BYTES = 2_000_000
SPEC_LABELS = {
    "name": "name",
    "manufacturer": "manufacturer",
    "developer": "manufacturer",
    "type": "type",
    "released": "released",
    "operating system": "os",
    "os": "os",
    "system on chip": "chipset",
    "soc": "chipset",
    "cpu": "cpu",
    "gpu": "gpu",
    "memory": "ram",
    "storage": "storage",
    "removable storage": "expandable_storage",
    "display": "display",
    "battery": "battery",
    "dimensions": "dimensions",
    "mass": "weight",
    "weight": "weight",
    "networks": "network",
}
KNOWN_WIKIPEDIA_TITLES = {
    # Vivo's model code is what the game reports, while Wikipedia uses the retail name.
    "v2514": "Vivo X300 Pro",
    "vivo v2514": "Vivo X300 Pro",
}


class DeviceSpecsNotFound(Exception):
    pass


class DeviceSpecsUnavailable(Exception):
    pass


class _InfoboxParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.table_depth = 0
        self.in_row = False
        self.cell = None
        self.label = []
        self.value = []
        self.rows = {}

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if not self.table_depth:
            classes = attributes.get("class", "").split()
            if tag == "table" and "infobox" in classes:
                self.table_depth = 1
            return
        if tag == "table":
            self.table_depth += 1
        elif tag == "tr" and self.table_depth == 1:
            self.in_row = True
            self.label, self.value = [], []
        elif self.in_row and self.table_depth == 1 and tag in ("th", "td"):
            self.cell = "label" if tag == "th" else "value"
        elif self.cell and tag == "br":
            (self.label if self.cell == "label" else self.value).append(" · ")

    def handle_endtag(self, tag):
        if not self.table_depth:
            return
        if tag in ("th", "td") and self.table_depth == 1:
            self.cell = None
        elif tag == "tr" and self.table_depth == 1:
            label = _plain("".join(self.label)).lower()
            value = _plain("".join(self.value))
            if label and value:
                self.rows[label] = value
            self.in_row = False
        elif tag == "table":
            self.table_depth -= 1

    def handle_data(self, data):
        if self.cell == "label":
            self.label.append(data)
        elif self.cell == "value":
            self.value.append(data)


def _plain(value):
    value = re.sub(r"\[[a-z]?\d+\]", "", value, flags=re.I)
    return re.sub(r"\s+", " ", value).strip(" ·\n\t")


def _request_json(params):
    url = f"{WIKIPEDIA_API}?{urlencode(params)}"
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "AVN-Analytics/1.0 (opt-in device specification lookup)",
        },
    )
    try:
        with urlopen(request, timeout=8) as response:  # noqa: S310 - fixed HTTPS host above
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise DeviceSpecsUnavailable("Wikipedia could not be reached") from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise DeviceSpecsUnavailable("Wikipedia returned an unexpectedly large response")
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DeviceSpecsUnavailable("Wikipedia returned an unreadable response") from error


def _specs_from_html(html):
    parser = _InfoboxParser()
    parser.feed(html)
    specs = {}
    for label, value in parser.rows.items():
        key = SPEC_LABELS.get(label)
        if key and key not in specs:
            specs[key] = value[:1000]
    return specs


def _model_key(model):
    return re.sub(r"[^a-z0-9]+", " ", model.lower()).strip()


def _result_for_title(title):
    parsed = _request_json(
        {
            "action": "parse",
            "page": title,
            "prop": "text",
            "format": "json",
            "formatversion": 2,
        }
    )
    specs = _specs_from_html(parsed.get("parse", {}).get("text", ""))
    hardware = sum(bool(specs.get(key)) for key in ("chipset", "cpu", "gpu", "ram", "storage"))
    if hardware < 2:
        return None
    article = quote(title.replace(" ", "_"), safe="()_")
    return {
        "provider": "Wikipedia",
        "matched_device": specs.pop("name", None) or title,
        "source_url": f"https://en.wikipedia.org/wiki/{article}",
        "specs": specs,
        "note": (
            "Catalog specifications may list several RAM or storage variants; "
            "they are not measurements from this player's exact unit."
        ),
    }


@lru_cache(maxsize=512)
def lookup(model):
    """Look up a model only after the dashboard user explicitly requests it."""
    known_title = KNOWN_WIKIPEDIA_TITLES.get(_model_key(model))
    if known_title:
        result = _result_for_title(known_title)
        if result:
            return result

    search = _request_json(
        {
            "action": "query",
            "list": "search",
            "srsearch": f"{model} smartphone",
            "srnamespace": 0,
            "srlimit": 3,
            "format": "json",
            "formatversion": 2,
        }
    )
    matches = search.get("query", {}).get("search", [])
    for match in matches:
        title = match.get("title")
        if not title or title == known_title:
            continue
        result = _result_for_title(title)
        if result:
            return result
    raise DeviceSpecsNotFound("No reliable device specification match was found")


def for_player(storage, game_id, player):
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        row = connection.execute(
            f"""SELECT json_extract(payload, '$.params.device_model') AS model
                FROM events WHERE {PLAYER}=? AND name='session_start'
                AND json_extract(payload, '$.params.device_model') IS NOT NULL
                ORDER BY client_ts DESC, event_id DESC LIMIT 1""",
            (player,),
        ).fetchone()
    model = str(row["model"]).strip() if row and row["model"] is not None else ""
    if not model:
        raise DeviceSpecsNotFound("This player has not sent a device model")
    return {"requested_model": model, **lookup(model)}
