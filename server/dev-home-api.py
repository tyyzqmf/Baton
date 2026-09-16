"""Loopback-only, read-only development entrypoint for the project overview."""

import argparse
import os
from pathlib import Path
import secrets
import sys

from fastapi import Depends, FastAPI, HTTPException, Request
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
from bridge_read import get_project_sessions


def read_api_key(env_file):
    key = os.environ.get("BATON_API_KEY", "").strip()
    if not key and env_file.is_file():
        for line in env_file.read_text().splitlines():
            name, separator, value = line.partition("=")
            if separator and name.strip() == "BATON_API_KEY":
                key = value.strip().strip("\"'")
                break
    if not key:
        raise ValueError("Configure BATON_API_KEY in the environment or the local env file")
    return key


def create_app(api_key):
    if not api_key:
        raise ValueError("A development API key is required")

    async def authorize(request: Request):
        supplied = request.headers.get("x-api-key", "")
        if not secrets.compare_digest(supplied.encode(), api_key.encode()):
            raise HTTPException(status_code=401, detail="Invalid API key")

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_api_route(
        "/api/bridge/project-sessions", get_project_sessions,
        methods=["GET"], dependencies=[Depends(authorize)],
    )
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env.local")
    parser.add_argument("--table", default=os.environ.get("BRIDGE_SESSIONS_TABLE"))
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()
    if not args.table:
        parser.error("--table or BRIDGE_SESSIONS_TABLE is required")
    try:
        api_key = read_api_key(args.env_file)
    except ValueError as error:
        parser.error(str(error))
    os.environ["AWS_REGION"] = args.region
    os.environ["BRIDGE_SESSIONS_TABLE"] = args.table
    uvicorn.run(create_app(api_key), host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()
