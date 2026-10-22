"""Prepared-answer hooks; implemented by the next review unit."""


def refresh(worker, game_id, revision):
    return False


def backlog(storage, connection, now):
    return {"views": 0, "views_waiting": 0, "lag_seconds": None}


def has_errors(storage, game_id):
    return False
