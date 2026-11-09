"""The small part of MCP (JSON-RPC over HTTP) that both of this app's MCP servers speak.

NutBot's own server (nutbot.py, for the agent it starts) and the read-only server for outside
agents (mcp_server.py) differ in who may call and which tools they get; the handshake and the
message handling are the same, so they live here.
"""


def handle(payload, *, tools, call, name, version="1", instructions=""):
    """Answers one JSON-RPC message. Returns (HTTP status, body or None).

    `call(tool, arguments)` runs a tool and returns (text, is_error).
    """
    method, ident = payload.get("method"), payload.get("id")

    def reply(result=None, error=None):
        if error:
            body = {"jsonrpc": "2.0", "id": ident, "error": {"code": -32000, "message": error}}
        else:
            body = {"jsonrpc": "2.0", "id": ident, "result": result}
        return 200, body

    if method == "initialize":
        asked = (payload.get("params") or {}).get("protocolVersion") or "2025-06-18"
        result = {
            "protocolVersion": asked,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": name, "version": version},
        }
        if instructions:
            result["instructions"] = instructions
        return reply(result)
    if (method or "").startswith("notifications/"):
        return 202, None
    if method == "ping":
        return reply({})
    if method == "tools/list":
        return reply({"tools": tools})
    if method == "tools/call":
        params = payload.get("params") or {}
        text, error = call(params.get("name"), params.get("arguments") or {})
        return reply({"content": [{"type": "text", "text": text}], "isError": error})
    return reply(error=f"Unknown method {method}")
