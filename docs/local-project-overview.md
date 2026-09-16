# Run the project overview API locally

Use this workflow to test the homepage's cross-device project groups without
deploying the backend or updating the existing stack.

## Prerequisites

- An existing stack and AWS credentials with permission to query its Sessions
  table and list index.
- Node.js and Python, plus the repository's installed frontend dependencies.
- The existing stack's `BATON_API_URL` and `BATON_API_KEY` in the gitignored
  `.env.local`. Do not put the key in shell arguments, screenshots, or logs.

## Start the read-only API

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r server/src/requirements.txt
.venv/bin/python server/dev-home-api.py \
  --region us-east-1 \
  --table Baton-bridge-sessions
```

Replace the region and table name if using a different stack. The process binds
only to `127.0.0.1:8081`, reads the API key from `.env.local`, and exposes only
`GET /api/bridge/project-sessions`. Missing or incorrect keys return `401`.
Existing sync, delete, and message routes are not mounted in this local process.

## Connect the local Web frontend

In a second terminal, from the repository root:

```bash
BATON_HOME_API_TARGET=http://127.0.0.1:8081 npm run dev -- --host 127.0.0.1
```

Alternatively, put `BATON_HOME_API_TARGET=http://127.0.0.1:8081` in `.env.local`
and start Vite normally. Open `http://localhost:5173/index.html` through the existing
authenticated browser, or use its forwarded development URL.

Only the project overview goes through this local proxy. Its request uses the Web
origin even if the browser has a saved cloud server address. Other requests,
including additional Session pages, continue to use the existing cloud API.
The API key and saved server preferences are not replaced.

Select **项目**. The overview request contains no `device` parameter. Each group
already includes up to five Sessions, so expansion makes no additional request.
**展示更多** loads another five Sessions for that device and directory;
**加载更多项目** loads another cross-device project page.

## Verify and stop

- Check both online and offline devices, same-name projects on different devices,
  Session pagination, and return navigation.
- If the overview fails, check the local API process, AWS credentials, table/index
  permissions, and table name. The UI keeps existing content and offers retry;
  it does not silently revert to per-device project requests.
- Stop the local API with Ctrl+C. Remove the proxy setting or start Vite with
  `BATON_HOME_API_TARGET=` to disable it. Then restart Vite.

The override is disabled in production builds and `vite preview`. A production
Web release needs the new backend route deployed first; this local workflow
does not perform that deployment or migrate/write business data.
