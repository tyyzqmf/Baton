import base64
import binascii
import json
import uuid
import time


MAX_FRAME_BYTES = 28 * 1024
CLIENT_TYPES = {"open", "input", "resize", "heartbeat", "close"}
BRIDGE_TYPES = {"ready", "output", "resized", "ack", "closed", "exit", "error"}
FIELDS = {
    "action", "v", "type", "terminalId", "device", "clientSeq", "eventSeq",
    "cols", "rows", "data", "shell", "cwd", "exitCode", "signal", "message", "profile",
}


def _integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def _size(body):
    return _integer(body.get("cols"), 2, 500) and _integer(body.get("rows"), 1, 200)


def _bytes(data, limit):
    if not isinstance(data, str) or not data or len(data) > ((limit + 2) // 3) * 4:
        return False
    try:
        decoded = base64.b64decode(data, validate=True)
        return len(decoded) <= limit and base64.b64encode(decoded).decode() == data
    except (ValueError, binascii.Error):
        return False


def _valid(body, role):
    try:
        if str(uuid.UUID(body.get("terminalId", ""))) != body["terminalId"]:
            return False
    except (ValueError, TypeError, AttributeError, KeyError):
        return False
    if type(body.get("v")) is not int or body["v"] != 1:
        return False
    if "profile" in body and type(body["profile"]) is not bool:
        return False
    if not isinstance(body.get("device"), str) or not 1 <= len(body["device"]) <= 128:
        return False
    if len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()) > MAX_FRAME_BYTES:
        return False
    kind = body.get("type")
    if role == "app":
        if kind not in CLIENT_TYPES or not _integer(body.get("clientSeq"), 0, 2**53 - 1):
            return False
        if (kind == "open") != (body["clientSeq"] == 0):
            return False
        return (kind not in {"open", "resize"} or _size(body)) and (kind != "input" or _bytes(body.get("data"), 4096))
    if role != "bridge" or kind not in BRIDGE_TYPES or not _integer(body.get("eventSeq"), 0, 2**53 - 1):
        return False
    if body["eventSeq"] == 0 and kind not in {"error", "ack"}:
        return False
    if kind == "output":
        return _bytes(body.get("data"), 16384)
    if kind in {"ready", "resized"} and not _size(body):
        return False
    if kind == "ready":
        return all(isinstance(body.get(key), str) and len(body[key]) <= 2048 for key in ("cwd", "shell"))
    if kind == "ack":
        return _integer(body.get("clientSeq"), 1, 2**53 - 1)
    if kind == "exit":
        return _integer(body.get("exitCode"), 0, 2**32 - 1) and _integer(body.get("signal", 0), 0, 255)
    if kind == "error":
        return isinstance(body.get("message"), str) and len(body["message"]) <= 2048
    return True


def _relay_terminal_poc(body, connection, connection_id, endpoint, *, query_connections, post_to_connection, connections_table):
    role = connection.get("role")
    account_id = connection.get("accountId")
    if not account_id or not _valid(body, role):
        return {"statusCode": 400}
    payload = {key: value for key, value in body.items() if key in FIELDS}
    if role == "app":
        candidates = [item for item in query_connections(account_id, "bridge") if item.get("deviceName") == body["device"]]
        if len(candidates) != 1:
            post_to_connection(endpoint, connection_id, {
                "action": "terminal_poc", "v": 1, "type": "error", "eventSeq": 0,
                "terminalId": body["terminalId"], "device": body["device"],
                "message": "Selected Bridge is offline or has duplicate connections; retry shortly",
            })
            return {"statusCode": 200}
        payload["replyConnectionId"] = connection_id
        if post_to_connection(endpoint, candidates[0]["connectionId"], payload) is False:
            post_to_connection(endpoint, connection_id, {
                "action": "terminal_poc", "v": 1, "type": "error", "eventSeq": 0,
                "terminalId": body["terminalId"], "device": body["device"], "message": "Selected Bridge disconnected",
            })
        return {"statusCode": 200}

    if body["device"] != connection.get("deviceName"):
        return {"statusCode": 403}
    target = body.get("replyConnectionId")
    if not isinstance(target, str) or not 1 <= len(target) <= 256:
        return {"statusCode": 400}
    recipient = connections_table.get_item(Key={"connectionId": target}, ConsistentRead=True).get("Item")
    if not recipient or recipient.get("role") != "app" or recipient.get("accountId") != account_id:
        return {"statusCode": 403}
    post_to_connection(endpoint, target, payload)
    return {"statusCode": 200}


def handle_terminal_poc(body, connection, connection_id, endpoint, *, query_connections, post_to_connection, connections_table, identity_ms=0):
    if body.get("profile") is not True:
        return _relay_terminal_poc(body, connection, connection_id, endpoint,
                                   query_connections=query_connections, post_to_connection=post_to_connection,
                                   connections_table=connections_table)
    started = time.perf_counter()
    metrics = {"identityMs": identity_ms}

    def measure(name, callback, *args, **kwargs):
        before = time.perf_counter()
        try:
            return callback(*args, **kwargs)
        finally:
            metrics[name] = metrics.get(name, 0) + (time.perf_counter() - before) * 1000

    class ProfiledConnections:
        def get_item(self, **kwargs):
            return measure("recipientLookupMs", connections_table.get_item, **kwargs)

    try:
        return _relay_terminal_poc(body, connection, connection_id, endpoint,
                                   query_connections=lambda *args: measure("routeQueryMs", query_connections, *args),
                                   post_to_connection=lambda *args: measure("postMs", post_to_connection, *args),
                                   connections_table=ProfiledConnections())
    finally:
        metrics["handlerMs"] = (time.perf_counter() - started) * 1000 + identity_ms
        print("[terminal-timing] " + json.dumps({
            "terminalId": body.get("terminalId"), "role": connection.get("role"),
            "type": body.get("type"), "clientSeq": body.get("clientSeq"), "eventSeq": body.get("eventSeq"),
            **{key: round(value, 3) for key, value in metrics.items()},
        }, separators=(",", ":")))
