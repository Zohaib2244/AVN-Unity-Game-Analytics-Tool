"""Named timeline highlights shared by the people with access to a game."""

import json
import sqlite3
from uuid import uuid4

from fastapi import HTTPException

from .models import timestamp

MAX_SAVED_HIGHLIGHTS = 100


def list_rules(storage, game_id):
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        return [
            {"id": row["id"], **json.loads(row["definition"]), "updated_at": row["updated_at"]}
            for row in connection.execute("SELECT * FROM highlight_rules ORDER BY name, id")
        ]


def save_rule(storage, game_id, rule_id, definition):
    storage.get_game(game_id)
    definition = {**definition, "name": definition["name"].strip()}
    if not definition["name"]:
        raise HTTPException(422, "Give the saved rule a name")
    updated_at = timestamp()
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute("BEGIN IMMEDIATE")
        if rule_id is not None:
            if not connection.execute(
                "SELECT 1 FROM highlight_rules WHERE id=?", (rule_id,)
            ).fetchone():
                raise HTTPException(404, "Saved highlight not found")
        elif connection.execute("SELECT count(*) FROM highlight_rules").fetchone()[0] >= (
            MAX_SAVED_HIGHLIGHTS
        ):
            raise HTTPException(400, "Use at most 100 saved highlights per game")
        rule_id = rule_id or str(uuid4())
        try:
            connection.execute(
                """INSERT INTO highlight_rules VALUES (?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name,
                   definition=excluded.definition, updated_at=excluded.updated_at""",
                (rule_id, definition["name"], json.dumps(definition), updated_at),
            )
        except sqlite3.IntegrityError as error:
            raise HTTPException(
                409, "A saved highlight already has that name. Choose another."
            ) from (error)
    return {"id": rule_id, **definition, "updated_at": updated_at}


def delete_rule(storage, game_id, rule_id):
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        if connection.execute("DELETE FROM highlight_rules WHERE id=?", (rule_id,)).rowcount == 0:
            raise HTTPException(404, "Saved highlight not found")
