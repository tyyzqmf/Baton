import argparse
import ast
import base64
import copy
import datetime
import hashlib
import io
import json
import pathlib
import tempfile
import urllib.request
import uuid
import zipfile

import boto3
from botocore.exceptions import WaiterError


RESOURCE_NAMES = {"TerminalDirectRole", "TerminalDirectAssumePolicy", "TerminalDirectIntegration",
                  "TerminalDirectIntegrationResponse", "TerminalDirectRoute", "TerminalDirectApi",
                  "TerminalDirectControlIntegration", "TerminalDirectConnectRoute", "TerminalDirectDisconnectRoute",
                  "TerminalDirectDefaultRoute", "TerminalDirectStage", "TerminalDirectPermission"}


def patch_handler(source, current):
    marker = "from terminal_direct_ws import handle_terminal_direct, terminal_direct_disconnect\n"
    if marker not in source:
        anchor = "from terminal_ws import handle_terminal_poc\n"
        if source.count(anchor) != 1:
            raise ValueError("Unexpected live handler import layout")
        source = source.replace(anchor, anchor + marker, 1)
    source = source.replace("return _handle_disconnect(connection_id)", "return _handle_disconnect(connection_id, endpoint)")
    start, end = source.index("def _handle_connect("), source.index("def _disconnect_terminal_data(") if "def _disconnect_terminal_data(" in source else source.index("def _handle_disconnect(")
    connected = source[start:end]
    if '    connected_endpoint = ' not in connected:
        anchor = '    if not api_key:\n        return {"statusCode": 401}\n'
        guard_start = current.index('    context = event.get("requestContext", {})\n', current.index("def _handle_connect("))
        guard_end = current.index('    account_id = _account_id(api_key)\n', guard_start)
        if connected.count(anchor) != 1:
            raise ValueError("Unexpected live connection authorization layout")
        connected = connected.replace(anchor, anchor + "\n" + current[guard_start:guard_end], 1)
        anchor = '    _connections_table.put_item(Item=item)\n'
        if connected.count(anchor) != 1:
            raise ValueError("Unexpected live connection storage layout")
        connected = connected.replace(anchor, '    if role == "terminal_data":\n        item["terminalDataEndpoint"] = connected_endpoint\n' + anchor, 1)
    if 'item["terminalProtocol"] = 2' not in connected:
        anchor = '    _connections_table.put_item(Item=item)\n'
        if connected.count(anchor) != 1:
            raise ValueError("Unexpected live connection storage layout")
        connected = connected.replace(anchor,
            '    if role == "bridge" and qs.get("terminal") == "2":\n        item["terminalProtocol"] = 2\n' + anchor, 1)
    source = source[:start] + connected + source[end:]
    start = source.index("def _disconnect_terminal_data(") if "def _disconnect_terminal_data(" in source else source.index("def _handle_disconnect(")
    end = source.index("def _handle_message(", start)
    names = {item.name for item in ast.parse(source[start:end]).body if isinstance(item, ast.FunctionDef)}
    if names - {"_disconnect_terminal_data", "_handle_disconnect"}:
        raise ValueError("Unexpected live disconnect extensions; manual merge required")
    replacement = current[current.index("def _disconnect_terminal_data("):current.index("def _handle_message(")]
    source = source[:start] + replacement + source[end:]
    anchor = '    account_id = conn.get("accountId", "")\n'
    if '    if action == "terminal_direct":\n' not in source:
        if source.count(anchor) != 1:
            raise ValueError("Unexpected live message routing layout")
        block_start = current.index('    if action == "terminal_direct":\n')
        block_end = current.index('    if role == "bridge"', block_start)
        source = source.replace(anchor, anchor + current[block_start:block_end], 1)
    ast.parse(source)
    return source


def merge_template(live, current, code):
    result = copy.deepcopy(live)
    for name in RESOURCE_NAMES:
        result["Resources"][name] = copy.deepcopy(current["Resources"][name])
    variables = result["Resources"]["WsHandler"]["Properties"]["Environment"]["Variables"]
    variables["TERMINAL_DIRECT_ROLE_ARN"] = {"Fn::GetAtt": ["TerminalDirectRole", "Arn"]}
    variables["TERMINAL_DIRECT_ENDPOINT"] = copy.deepcopy(current["Resources"]["WsHandler"]["Properties"]["Environment"]["Variables"]["TERMINAL_DIRECT_ENDPOINT"])
    result["Resources"]["WsHandler"]["Properties"]["Code"] = copy.deepcopy(code)
    return result


def patched_archive(original, source_directory):
    incoming = zipfile.ZipFile(io.BytesIO(original))
    current = (source_directory / "bridge_ws.py").read_text()
    patched = patch_handler(incoming.read("bridge_ws.py").decode(), current).encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry in incoming.infolist():
            if entry.filename == "terminal_direct_ws.py":
                continue
            content = patched if entry.filename == "bridge_ws.py" else incoming.read(entry.filename)
            archive.writestr(entry, content)
        archive.writestr("terminal_direct_ws.py", (source_directory / "terminal_direct_ws.py").read_bytes())
    return output.getvalue()


def allowed_change(change, live, merged):
    name = change["LogicalResourceId"]
    if change["Action"] == "Remove" or (change.get("Replacement") == "True" and name not in {
            "TerminalDirectIntegration", "TerminalDirectIntegrationResponse", "TerminalDirectRoute"}):
        return False
    if name in RESOURCE_NAMES | {"WsHandler"}:
        return True
    return (name == "WsIntegration" and change["Action"] == "Modify" and change.get("Replacement") == "False"
        and live["Resources"][name] == merged["Resources"][name]
        and all(detail.get("Target", {}).get("Name") == "IntegrationUri" for detail in change.get("Details", [])))


def main():
    parser = argparse.ArgumentParser(description="Opt-in Header terminal deployment preserving the live template and legacy Lambda ZIP")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--stack", default="Baton")
    parser.add_argument("--region", default="ap-northeast-1")
    args = parser.parse_args()
    if not args.run:
        parser.print_help()
        return
    root = pathlib.Path(__file__).resolve().parents[1]
    session = boto3.Session(region_name=args.region)
    cloudformation, functions = session.client("cloudformation"), session.client("lambda")
    function_name = args.stack + "-ws-handler"
    directory = pathlib.Path(tempfile.mkdtemp(prefix="terminal-direct-deploy-"))
    report = {"startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "stack": args.stack, "region": args.region}

    def save(name, content):
        target = directory / name
        target.write_bytes(content if isinstance(content, bytes) else content.encode())
        target.chmod(0o600)

    def metadata():
        save("metadata.json", json.dumps(report, indent=2))

    print("Private deployment backup:", directory, flush=True)
    response = cloudformation.get_template(StackName=args.stack, TemplateStage="Original")["TemplateBody"]
    live = json.loads(response) if isinstance(response, str) else response
    current = json.loads((root / "server/template/Baton.template").read_text())
    function = functions.get_function(FunctionName=function_name)
    original = urllib.request.urlopen(function["Code"]["Location"], timeout=30).read()
    archive = patched_archive(original, root / "server/src")
    save("before.zip", original)
    save("after.zip", archive)
    save("before-template.json", json.dumps(live, indent=2))
    save("before-function-config.json", json.dumps(function["Configuration"], default=str, indent=2))
    report["beforeCodeSha256"] = function["Configuration"]["CodeSha256"]
    old_names = set(zipfile.ZipFile(io.BytesIO(original)).namelist())
    new_names = set(zipfile.ZipFile(io.BytesIO(archive)).namelist())
    if not old_names.issubset(new_names):
        raise ValueError("Deployment would remove existing Lambda files")
    report["preservedFiles"] = len(old_names)
    report["legacyTerminalPreserved"] = "project/terminal_ws.py" in new_names
    account = session.client("sts").get_caller_identity()["Account"]
    bucket = f"{args.stack.lower()}-{args.region}-images-{account}"
    storage = session.client("s3")
    protection = storage.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
    if not all(protection.get(name) for name in ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]):
        raise RuntimeError("Deployment bucket must block all public access")
    object_key = "deploy/terminal-direct/" + uuid.uuid4().hex + ".zip"
    uploaded = storage.put_object(Bucket=bucket, Key=object_key, Body=archive, ServerSideEncryption="AES256")
    code = {"S3Bucket": bucket, "S3Key": object_key}
    if uploaded.get("VersionId"):
        code["S3ObjectVersion"] = uploaded["VersionId"]
    template = merge_template(live, current, code)
    save("after-template.json", json.dumps(template, indent=2))
    report["codeArtifact"] = code
    report["expectedCodeSha256"] = base64.b64encode(hashlib.sha256(archive).digest()).decode()
    stack = cloudformation.describe_stacks(StackName=args.stack)["Stacks"][0]
    parameters = [{"ParameterKey": parameter["ParameterKey"], "UsePreviousValue": True} for parameter in stack.get("Parameters", [])]
    change_set = cloudformation.create_change_set(StackName=args.stack, ChangeSetName="terminal-direct-" + uuid.uuid4().hex[:12],
        ChangeSetType="UPDATE", TemplateBody=json.dumps(template), Parameters=parameters,
        Capabilities=["CAPABILITY_NAMED_IAM"])["Id"]
    report["changeSetId"] = change_set
    metadata()
    try:
        cloudformation.get_waiter("change_set_create_complete").wait(ChangeSetName=change_set,
            WaiterConfig={"Delay": 2, "MaxAttempts": 90})
    except WaiterError:
        details = cloudformation.describe_change_set(ChangeSetName=change_set)
        reason = details.get("StatusReason", "")
        if "didn't contain changes" not in reason and "No updates" not in reason:
            report["changeSetFailure"] = reason
            metadata()
            raise RuntimeError("CloudFormation change set failed; inspect private metadata") from None
    details = cloudformation.describe_change_set(ChangeSetName=change_set)
    save("change-set.json", json.dumps(details, default=str, indent=2))
    changes = [{key: entry["ResourceChange"].get(key) for key in ["LogicalResourceId", "Action", "Replacement"]}
               for entry in details.get("Changes", [])]
    report["changes"] = changes
    print("Targeted changes:", json.dumps(changes), flush=True)
    if any(not allowed_change(entry["ResourceChange"], live, template) for entry in details.get("Changes", [])):
        cloudformation.delete_change_set(ChangeSetName=change_set)
        raise RuntimeError("Refusing unrelated or replacing infrastructure changes")
    if changes:
        latest = functions.get_function_configuration(FunctionName=function_name)
        if latest["CodeSha256"] != report["beforeCodeSha256"]:
            cloudformation.delete_change_set(ChangeSetName=change_set)
            raise RuntimeError("Live Lambda code changed concurrently; refusing to overwrite it")
        disable_rollback = "ZipFile" in live["Resources"]["WsHandler"]["Properties"]["Code"]
        cloudformation.execute_change_set(ChangeSetName=change_set, DisableRollback=disable_rollback)
        try:
            cloudformation.get_waiter("stack_update_complete").wait(StackName=args.stack, WaiterConfig={"Delay": 3, "MaxAttempts": 200})
        except WaiterError:
            report["deploymentFailed"] = True
            metadata()
            raise RuntimeError("Deployment incomplete; inspect private backups and stack events before retrying.") from None
    else:
        cloudformation.delete_change_set(ChangeSetName=change_set)
    report["infrastructureComplete"] = True
    metadata()
    functions.get_waiter("function_updated_v2").wait(FunctionName=function_name)
    final = functions.get_function_configuration(FunctionName=function_name)
    if final["CodeSha256"] != report["expectedCodeSha256"]:
        raise RuntimeError("Deployed Lambda archive does not match the preserved, patched artifact")
    report["afterCodeSha256"] = final["CodeSha256"]
    report["memorySize"] = final["MemorySize"]
    report["completedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    metadata()
    print("Header terminal API deployed; legacy files preserved; memory:", final["MemorySize"], flush=True)


if __name__ == "__main__":
    main()
