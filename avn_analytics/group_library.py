"""Reusable group definitions and named checks, shared per game; deletion supports Undo."""

import json
import sqlite3
from uuid import uuid4

from fastapi import HTTPException

from .models import timestamp

MAX_SAVED_ITEMS = 200


def _item(row):
    return {"id": row["id"], **json.loads(row["definition"]), "updated_at": row["updated_at"]}


def list_items(storage, game_id):
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        return [
            _item(row)
            for row in connection.execute(
                "SELECT * FROM player_group_library WHERE deleted_at IS NULL ORDER BY name, id"
            )
        ]


def _capacity(connection):
    count = connection.execute(
        "SELECT count(*) FROM player_group_library WHERE deleted_at IS NULL"
    ).fetchone()[0]
    if count >= MAX_SAVED_ITEMS:
        raise HTTPException(400, f"Use at most {MAX_SAVED_ITEMS} saved items per game")


def save(storage, game_id, item_id, definition):
    storage.get_game(game_id)
    updated = timestamp()
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute("BEGIN IMMEDIATE")
        if item_id is None:
            _capacity(connection)
        else:
            row = connection.execute(
                "SELECT * FROM player_group_library WHERE id=? AND deleted_at IS NULL", (item_id,)
            ).fetchone()
            if row is None:
                raise HTTPException(404, "Saved item not found")
            if row["kind"] != definition["kind"]:
                raise HTTPException(422, "Keep the saved item's type")
        item_id = item_id or str(uuid4())
        try:
            connection.execute(
                """INSERT INTO player_group_library VALUES (?, ?, ?, ?, ?, NULL)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name,
                   definition=excluded.definition, updated_at=excluded.updated_at""",
                (item_id, definition["kind"], definition["name"], json.dumps(definition), updated),
            )
        except sqlite3.IntegrityError as error:
            raise HTTPException(409, "That name is already used. Choose another.") from error
    return {"id": item_id, **definition, "updated_at": updated}


def remove(storage, game_id, item_id):
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        if not connection.execute(
            "UPDATE player_group_library SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
            (timestamp(), item_id),
        ).rowcount:
            raise HTTPException(404, "Saved item not found")


def restore(storage, game_id, item_id):
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM player_group_library WHERE id=?", (item_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(404, "Saved item not found")
        if row["deleted_at"] is not None:
            _capacity(connection)
            try:
                connection.execute(
                    "UPDATE player_group_library SET deleted_at=NULL WHERE id=?", (item_id,)
                )
            except sqlite3.IntegrityError as error:
                raise HTTPException(
                    409, "That name is now used. Rename the other item first."
                ) from error
        return _item(row)
