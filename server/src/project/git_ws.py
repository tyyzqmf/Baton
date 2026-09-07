import re
import uuid


ALLOWED_OPERATIONS = {"status", "stage", "unstage", "discard", "diff"}
ALLOWED_GROUPS = {"conflicts", "staged", "changes"}
MUTATION_GROUPS = {
    "stage": {"changes", "conflicts"},
    "unstage": {"staged"},
    "discard": {"changes"},
}


def _valid_uuid(value):
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _valid_path(value):
    if not isinstance(value, str) or not value or "\0" in value:
        return False
    if value.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", value):
        return False
    return ".." not in value.replace("\\", "/").split("/")


def _valid_request(body):
    operation = body.get("operation")
    if operation not in ALLOWED_OPERATIONS:
        return False
    if not isinstance(body.get("projectHash"), str) or not body["projectHash"]:
        return False
    if not _valid_uuid(body.get("requestId")):
        return False
    if operation == "status":
        return True
    if operation == "diff":
        if body.get("group") not in ALLOWED_GROUPS or not _valid_path(body.get("path")):
            return False
        if body.get("diffToken"):
            cursor = body.get("cursor", "0")
            return isinstance(body["diffToken"], str) and str(cursor).isdigit()
        return not body.get("cursor")
    if body.get("group") not in MUTATION_GROUPS[operation]:
        return False
    has_path = _valid_path(body.get("path"))
    is_all = body.get("all") is True
    if has_path == is_all:
        return False
    return not is_all or (
        isinstance(body.get("snapshotId"), str) and bool(body["snapshotId"])
    )


def _request_payload(body, reply_connection_id):
    payload = {
        "action": "git_status",
        "operation": body["operation"],
        "requestId": body["requestId"],
        "projectHash": body["projectHash"],
        "replyConnectionId": reply_connection_id,
    }
    for field in (
        "group", "path", "all", "snapshotId", "diffToken", "cursor",
    ):
        if field in body:
            payload[field] = body[field]
    return payload


def handle_git_status(
    body,
    role,
    connection_id,
    account_id,
    endpoint,
    *,
    query_connections,
    post_to_connection,
    connections_table,
):
    if role == "app":
        if not _valid_request(body):
            return {"statusCode": 400}
        device = body.get("device", "")
        payload = _request_payload(body, connection_id)
        delivered = 0
        for item in query_connections(account_id, "bridge"):
            if device and item.get("deviceName", "") != device:
                continue
            if post_to_connection(endpoint, item["connectionId"], payload) is not False:
                delivered += 1
        if delivered == 0:
            post_to_connection(endpoint, connection_id, {
                "action": "git_status",
                "operation": body["operation"],
                "requestId": body["requestId"],
                "ok": False,
                "sequence": 0,
                "chunkCount": 1,
                "complete": True,
                "errorCode": "bridge_offline",
                "error": "Bridge offline",
            })
        return {"statusCode": 200}

    if role != "bridge":
        return {"statusCode": 200}
    reply_connection_id = body.get("replyConnectionId", "")
    if not reply_connection_id:
        return {"statusCode": 400}
    connection = connections_table.get_item(
        Key={"connectionId": reply_connection_id},
    ).get("Item")
    if not connection \
            or connection.get("role") != "app" \
            or connection.get("accountId") != account_id:
        return {"statusCode": 200}
    payload = dict(body)
    payload.pop("replyConnectionId", None)
    post_to_connection(endpoint, reply_connection_id, payload)
    return {"statusCode": 200}
