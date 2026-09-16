import asyncio
import copy
import importlib.util
import os
import sys
import threading
import time

import pytest
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"))
import bridge_read


class Request:
    headers = {"x-api-key": "test-key"}


ACCOUNT = bridge_read._account_id(Request())


def encode(item):
    serializer = TypeSerializer()
    return {key: serializer.serialize(value) for key, value in item.items()}


def project(device, name="repo", count=9, last="2026-09-16T12:00:00Z", account=ACCOUNT):
    return {
        "accountId": account, "sk": f"PROJ#{device}#{name}", "deviceName": device,
        "projectHash": name, "projectName": f"/work/{name}", "sessionCount": count,
        "lastActive": last,
    }


def session(device, number, name="repo", account=ACCOUNT, **extra):
    return {
        "accountId": account, "sk": f"SESS#{device}#{name}#s{number:03}",
        "listPk": bridge_read._session_list_pk(account, device, name),
        "listSk": f"2026-09-16T12:{number:02}:00Z#s{number:03}",
        "sessionId": f"s{number:03}", "preview": f"Session {number}",
        "lastActive": f"2026-09-16T12:{number:02}:00Z", "status": "completed",
        **extra,
    }


class Client:
    def __init__(self, projects=(), sessions=(), devices=()):
        self.metadata = [*projects, *devices]
        self.sessions = list(sessions)
        self.metadata_queries = []
        self.session_queries = []
        self.metadata_pages = 0
        self.fail_prefix = None
        self.fail_list = None
        self.lock = threading.Lock()
        self.running = 0
        self.max_running = 0

    def get_paginator(self, operation):
        assert operation == "query"
        return self

    def paginate(self, **params):
        assert "IndexName" not in params
        assert params["TableName"] == "test-sessions"
        assert params["KeyConditionExpression"] == "#account = :account AND begins_with(#sk, :prefix)"
        self.metadata_queries.append(params)
        values = params["ExpressionAttributeValues"]
        account, prefix = values[":account"]["S"], values[":prefix"]["S"]
        if prefix == self.fail_prefix:
            raise ClientError({"Error": {"Code": "InternalServerError"}}, "Query")
        items = [
            item for item in self.metadata
            if item["accountId"] == account and item["sk"].startswith(prefix)
        ]
        for offset in range(0, len(items), 2):
            self.metadata_pages += 1
            yield {"Items": [encode(item) for item in items[offset:offset + 2]]}

    def query(self, **params):
        assert params["TableName"] == "test-sessions"
        assert params["IndexName"] == bridge_read.LIST_INDEX_NAME
        assert params["ScanIndexForward"] is False
        assert 1 <= params["Limit"] <= 5
        list_pk = params["ExpressionAttributeValues"][":list"]["S"]
        with self.lock:
            self.running += 1
            self.max_running = max(self.max_running, self.running)
            self.session_queries.append(params)
        try:
            time.sleep(0.002)
            if list_pk == self.fail_list:
                raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "Query")
            items = sorted(
                (item for item in self.sessions if item["listPk"] == list_pk),
                key=lambda item: item["listSk"], reverse=True,
            )
            start = params.get("ExclusiveStartKey")
            if start:
                items = [item for item in items if item["listSk"] < start["listSk"]["S"]]
            selected = items[:params["Limit"]]
            fields = [
                params["ExpressionAttributeNames"].get(name.strip(), name.strip())
                for name in params["ProjectionExpression"].split(",")
            ]
            result = {"Items": [encode({k: v for k, v in item.items() if k in fields}) for item in selected]}
            if len(items) > len(selected):
                result["LastEvaluatedKey"] = encode({
                    name: selected[-1][name] for name in ("accountId", "sk", "listPk", "listSk")
                })
            return result
        finally:
            with self.lock:
                self.running -= 1


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv("BRIDGE_SESSIONS_TABLE", "test-sessions")

    def install(client):
        monkeypatch.setattr(bridge_read, "_project_home_client", lambda: client)
        app = FastAPI()
        app.include_router(bridge_read.read_router)
        return TestClient(app, headers=Request.headers)

    return install


def test_all_device_directories_include_offline_and_missing_device_records(setup):
    client = Client(
        projects=[
            project("Mac"), project("offline"), project("missing-device"),
            project("Mac", "another-directory"), project("foreign", account="foreign-account"),
        ],
        sessions=[session(device, i) for device in ("Mac", "offline", "missing-device") for i in range(9)],
        devices=[{
            "accountId": ACCOUNT, "sk": "DEV#Mac", "deviceName": "Mac",
            "deviceDisplayName": "Office Mac",
        }],
    )
    api = setup(client)
    result = api.get("/api/bridge/project-sessions").json()
    assert len(result["projects"]) == 4
    assert result["hasMore"] is False and result["nextCursor"] is None
    by_key = {(p["deviceName"], p["projectHash"]): p for p in result["projects"]}
    assert by_key[("Mac", "repo")]["deviceDisplayName"] == "Office Mac"
    assert by_key[("missing-device", "repo")]["deviceDisplayName"] == "missing-device"
    assert by_key[("offline", "repo")]["sessionPage"]["sessions"][0]["sessionId"] == "s008"
    assert len(by_key[("Mac", "repo")]["sessionPage"]["sessions"]) == 5
    assert by_key[("Mac", "repo")]["projectPath"] == "/work/repo"
    assert {q["ExpressionAttributeValues"][":prefix"]["S"] for q in client.metadata_queries} == {"PROJ#", "DEV#"}
    assert client.metadata_pages == 3
    assert len(client.session_queries) == 4


def test_project_pagination_is_global_stable_and_does_not_prefetch_later_groups(setup):
    client = Client(
        projects=[project(f"device-{i:02}", last="2026-09-16T12:00:00Z") for i in range(53)],
    )
    api = setup(client)
    first = api.get("/api/bridge/project-sessions").json()
    assert len(first["projects"]) == 50 and first["hasMore"]
    assert len(client.session_queries) == 50
    assert first["projects"][0]["deviceName"] == "device-52"
    # A new item before the cursor must not shift the next page or duplicate rows.
    client.metadata.append(project("new-device", last="2026-09-17T12:00:00Z"))
    second = api.get("/api/bridge/project-sessions", params={"cursor": first["nextCursor"]}).json()
    assert [p["deviceName"] for p in second["projects"]] == ["device-02", "device-01", "device-00"]
    assert second["hasMore"] is False and second["nextCursor"] is None
    assert len(client.session_queries) == 53
    assert client.max_running <= 8


@pytest.mark.parametrize("count", [0, 1, 5, 6, 10])
def test_first_session_page_and_legacy_cursor_compatibility(setup, monkeypatch, count):
    client = Client(projects=[project("Mac", count=count)], sessions=[session("Mac", i) for i in range(count)])
    api = setup(client)
    page = api.get("/api/bridge/project-sessions").json()["projects"][0]["sessionPage"]
    assert len(page["sessions"]) == min(5, count)
    assert page["hasMore"] is (count > 5)
    assert [s["sessionId"] for s in page["sessions"]] == [f"s{i:03}" for i in range(count - 1, max(-1, count - 6), -1)]
    if count <= 5:
        assert page["nextCursor"] is None
        return
    key = bridge_read._decode_list_cursor(
        page["nextCursor"], ACCOUNT, bridge_read._session_list_pk(ACCOUNT, "Mac", "repo"),
    )
    assert key["sk"] == f"SESS#Mac#repo#s{count - 5:03}"

    class Resource:
        def query(self, **kwargs):
            response = client.query(
                TableName="test-sessions", IndexName=kwargs["IndexName"],
                ScanIndexForward=kwargs["ScanIndexForward"], Limit=kwargs["Limit"],
                ExpressionAttributeValues={":list": {"S": kwargs["KeyConditionExpression"].get_expression()["values"][1]}},
                ExpressionAttributeNames=kwargs["ExpressionAttributeNames"],
                ProjectionExpression=kwargs["ProjectionExpression"],
                ExclusiveStartKey=encode(kwargs["ExclusiveStartKey"]),
            )
            return {
                "Items": [bridge_read._deserialize_home_item(item) for item in response["Items"]],
                **({"LastEvaluatedKey": bridge_read._deserialize_home_item(response["LastEvaluatedKey"])} if response.get("LastEvaluatedKey") else {}),
            }

    monkeypatch.setattr(bridge_read, "_tables", lambda: (Resource(), None))
    more = api.get("/api/bridge/sessions", params={
        "device": "Mac", "project": "repo", "limit": 5, "cursor": page["nextCursor"],
    })
    assert more.status_code == 200
    assert len(more.json()["sessions"]) == count - 5
    assert {s["sessionId"] for s in more.json()["sessions"]}.isdisjoint(s["sessionId"] for s in page["sessions"])


def test_status_and_agent_rules_are_shared_and_children_do_not_use_preview_slots(setup):
    rows = [session("Mac", i) for i in range(8)]
    rows[-1]["parentSessionId"] = "root"
    rows[-2].update({
        "sessionId": "codex:native", "status": "needs_input", "agentDetail": "Approve command",
        "agentCount": 2, "isAgent": True, "agentName": "reviewer",
    })
    rows[-3]["activeStatus"] = "running"
    api = setup(Client(projects=[project("Mac")], sessions=rows))
    page = api.get("/api/bridge/project-sessions").json()["projects"][0]["sessionPage"]
    assert len(page["sessions"]) == 5
    first = page["sessions"][0]
    assert first["sessionId"] == "codex:native"
    assert first["status"] == "needs_input" and first["agentDetail"] == "Approve command"
    assert first["agentCount"] == 2 and first["agentName"] == "reviewer"
    assert page["sessions"][1]["status"] == "running"
    assert all("parentSessionId" not in item for item in page["sessions"])


def test_project_cursors_reject_wrong_account_scope_or_shape_before_reading(setup):
    client = Client(projects=[project("Mac")])
    api = setup(client)
    valid = {"v": 1, "scope": "home-projects", "accountId": ACCOUNT, "after": ["", "Mac", "repo"]}
    invalid = [
        "not-a-cursor",
        bridge_read._encode_list_cursor({**valid, "accountId": "other"}),
        bridge_read._encode_list_cursor({**valid, "scope": "sessions"}),
        bridge_read._encode_list_cursor({**valid, "after": ["", "Mac"]}),
        bridge_read._encode_list_cursor({**valid, "after": ["", 123, "repo"]}),
        bridge_read._encode_list_cursor([]),
        "A" * 8193,
    ]
    for cursor in invalid:
        response = api.get("/api/bridge/project-sessions", params={"cursor": cursor})
        assert response.status_code == 400
    assert not client.metadata_queries and not client.session_queries


@pytest.mark.parametrize("limit", [0, 51, -1, "bad"])
def test_project_limit_validation(setup, limit):
    client = Client()
    api = setup(client)
    assert api.get("/api/bridge/project-sessions", params={"limit": limit}).status_code == 422
    assert not client.metadata_queries


@pytest.mark.parametrize("failure", ["PROJ#", "DEV#", "session"])
def test_query_failures_are_not_reported_as_empty_or_partial_success(setup, failure):
    client = Client(projects=[project("Mac")], sessions=[session("Mac", 1)])
    if failure == "session":
        client.fail_list = bridge_read._session_list_pk(ACCOUNT, "Mac", "repo")
    else:
        client.fail_prefix = failure
    api = setup(client)
    response = api.get("/api/bridge/project-sessions")
    assert response.status_code == 503
    assert response.json() == {"detail": "Unable to load project sessions"}


def test_simultaneous_overviews_share_an_eight_worker_read_limit(setup):
    client = Client(projects=[project(f"device-{i}") for i in range(20)])
    setup(client)

    async def run():
        return await asyncio.gather(*(
            bridge_read.get_project_sessions(Request(), 50, None) for _ in range(2)
        ))

    original = copy.deepcopy(client.metadata)
    results = asyncio.run(run())
    assert all(len(result["projects"]) == 20 for result in results)
    assert 1 < client.max_running <= 8
    assert client.metadata == original


def dev_module():
    path = os.path.join(os.path.dirname(__file__), "..", "..", "server", "dev-home-api.py")
    spec = importlib.util.spec_from_file_location("dev_home_api", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_local_entrypoint_requires_the_configured_key_and_exposes_only_the_read_route(setup):
    database = Client()
    setup(database)
    app = dev_module().create_app("test-key")
    with TestClient(app) as api:
        for headers in ({}, {"x-api-key": "wrong-key"}):
            assert api.get("/api/bridge/project-sessions", headers=headers).status_code == 401
        assert not database.metadata_queries
        result = api.get("/api/bridge/project-sessions", headers=Request.headers)
        assert result.status_code == 200
        assert result.json() == {"projects": [], "hasMore": False, "nextCursor": None}
        assert api.post("/api/bridge/project-sessions", headers=Request.headers).status_code == 405
        for path in ("/api/bridge/sync-sessions", "/api/bridge/projects", "/api/bridge/sessions", "/docs", "/openapi.json"):
            assert api.get(path, headers=Request.headers).status_code == 404


def test_local_key_configuration_never_needs_a_key_in_command_line_arguments(monkeypatch, tmp_path):
    module = dev_module()
    monkeypatch.delenv("BATON_API_KEY", raising=False)
    env_file = tmp_path / ".env.local"
    env_file.write_text('OTHER_SECRET=ignored\nBATON_API_KEY="file-key"\n')
    assert module.read_api_key(env_file) == "file-key"
    monkeypatch.setenv("BATON_API_KEY", "environment-key")
    assert module.read_api_key(env_file) == "environment-key"
    monkeypatch.delenv("BATON_API_KEY")
    with pytest.raises(ValueError, match="Configure BATON_API_KEY"):
        module.read_api_key(tmp_path / "missing")
