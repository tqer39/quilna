#!/usr/bin/env python3
"""Exercise native CLI turn/tool read policies with fixed loopback SSE, never a model."""

import argparse
from contextlib import contextmanager
import http.server
import json
import os
from pathlib import Path
import secrets
import selectors
import shlex
import signal
import subprocess
import tempfile
import threading
import time
import unittest


def available_tools(items, namespace=None):
    """Flatten tool namespaces so the fixed response can use the CLI-advertised command tool."""
    result = []
    for item in items:
        if item.get("type") == "namespace":
            result.extend(available_tools(item.get("tools", []), item.get("name")))
        elif item.get("name"):
            result.append((namespace, item))
    return result


class FixedResponses(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        """Accept bounded request bodies and emit deterministic tool-call or final SSE responses."""
        length = int(self.headers.get("Content-Length", "0"))
        if length > 4 * 1024 * 1024:
            self.send_error(413)
            return
        body = json.loads(self.rfile.read(length))
        self.server.requests.append(body)
        number = len(self.server.requests)
        if number == 1:
            tools = list(body.get("tools", []))
            for item in body.get("input", []):
                if item.get("type") == "additional_tools":
                    tools.extend(item.get("tools", []))
            available = available_tools(tools)
            selected = next(((ns, tool) for ns, tool in available if tool["name"] == "exec_command"), None)
            arguments = {"cmd": self.server.command, "workdir": self.server.workspace,
                         "login": False, "max_output_tokens": 1024}
            if selected:
                namespace, tool = selected
                item = {"type": "function_call", "call_id": "offline-read",
                        "name": tool["name"], "arguments": json.dumps(arguments)}
            else:
                namespace, tool = next((ns, tool) for ns, tool in available if tool["name"] == "exec")
                item = {"type": "custom_tool_call", "call_id": "offline-read", "name": tool["name"],
                        "input": "const r = await tools.exec_command(" + json.dumps(arguments) + "); text(r);"}
            if namespace:
                item["namespace"] = namespace
        else:
            item = {"type": "message", "id": "offline-final", "role": "assistant",
                    "content": [{"type": "output_text", "text": '{"ok":true}'}]}
        response = "offline-response-" + str(number)
        events = [
            {"type": "response.created", "response": {"id": response}},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"id": response,
             "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
        ]
        payload = "".join("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        """Reject unsupported routes instead of forwarding them to another service."""
        self.send_error(404)

    def log_message(self, *_args):
        """Suppress HTTP access logs for this synthetic local fixture."""
        pass


class NativeClient:
    def __init__(self, process):
        """Track framed replies and notifications from one isolated app-server process."""
        self.process = process
        self.selector = selectors.DefaultSelector()
        self.selector.register(process.stdout, selectors.EVENT_READ)
        self.buffer = bytearray()
        self.pending = []
        self.counter = 0

    def send(self, value):
        """Write and flush one newline-delimited JSON message to the server."""
        self.process.stdin.write((json.dumps(value) + "\n").encode())
        self.process.stdin.flush()

    def receive(self, deadline):
        """Read within the deadline and refuse unexpected server-originated approval or tool requests."""
        while b"\n" not in self.buffer:
            if not self.selector.select(timeout=max(0, deadline - time.monotonic())):
                raise TimeoutError("native CLI response")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("native CLI exited before response")
            self.buffer.extend(chunk)
            if len(self.buffer) > 4 * 1024 * 1024:
                raise RuntimeError("native CLI fixture message limit")
        line, _, remainder = self.buffer.partition(b"\n")
        self.buffer[:] = remainder
        value = json.loads(line)
        if "method" in value and "id" in value:
            raise RuntimeError("unexpected approval/tool request: " + value["method"])
        return value

    def call(self, method, params):
        """Match a request identifier while retaining intervening notifications and surfacing RPC errors."""
        self.counter += 1
        identifier = self.counter
        self.send({"id": identifier, "method": method, "params": params})
        deadline = time.monotonic() + 20
        while True:
            value = self.receive(deadline)
            if value.get("id") == identifier:
                if "error" in value:
                    raise RuntimeError(method + ": " + value["error"].get("message", "RPC error"))
                return value.get("result")
            self.pending.append(value)

    def completed_turn(self):
        """Consume queued and live notifications until a turn completes or the deadline expires."""
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            value = self.pending.pop(0) if self.pending else self.receive(deadline)
            if value.get("method") == "turn/completed":
                return value["params"]["turn"]
        raise TimeoutError("native CLI turn completion")


@contextmanager
def native_fixture(binary, directory):
    """Run an isolated CLI against a fixed loopback provider and close every process and server resource."""
    home = directory / "empty-codex-home"
    home.mkdir()
    workspace = directory / "workspace"
    workspace.mkdir()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixedResponses)
    server.requests = []
    server.workspace = str(workspace)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    arguments = [str(binary), "app-server", "--listen", "stdio://"]
    config = [
        'sandbox_mode="read-only"', 'approval_policy="untrusted"', 'shell_environment_policy.inherit="none"',
        'features.apps=false', 'features.plugins=false', 'features.multi_agent=false', 'features.hooks=false',
        'notify=[]', 'web_search="disabled"', 'model_provider="offline_fixture"',
        'model_providers.offline_fixture.name="Offline validation"',
        'model_providers.offline_fixture.wire_api="responses"',
        'model_providers.offline_fixture.requires_openai_auth=false',
        'model_providers.offline_fixture.base_url="http://127.0.0.1:' + str(server.server_port) + '/v1"',
    ]
    for setting in config:
        arguments.extend(["-c", setting])
    environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(directory),
                   "CODEX_HOME": str(home), "LANG": "en_US.UTF-8", "TMPDIR": str(directory)}
    process = None
    client = None
    try:
        process = subprocess.Popen(arguments, cwd=workspace, env=environment, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, start_new_session=True)
        client = NativeClient(process)
        client.call("initialize", {"clientInfo": {"name": "offline_read_policy", "version": "0.1.0"},
                                 "capabilities": {"experimentalApi": True}})
        client.send({"method": "initialized", "params": {}})
        yield client, workspace, server
    finally:
        if process:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            process.stdin.close()
            process.stdout.close()
        if client:
            client.selector.close()
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


class ReadPolicyTests(unittest.TestCase):
    def check_policy(self, restricted, directory_grant=False):
        """Compare allowed and unlisted canary reads under the requested scope using fixed provider responses."""
        with tempfile.TemporaryDirectory(prefix="native-read-policy-", dir=SCRATCH) as temporary:
            with native_fixture(BINARY, Path(temporary).resolve()) as (client, workspace, server):
                allowed = workspace / "allowed.txt"
                unlisted = workspace / "unlisted.txt"
                grant = allowed
                if directory_grant:
                    grant = workspace / "allowed-tree"
                    ignored = grant / "ignored"
                    ignored.mkdir(parents=True)
                    allowed = ignored / "cached.txt"
                    (workspace / ".gitignore").write_text("allowed-tree/ignored/\n")
                    git_environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(workspace.parent),
                                       "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
                    subprocess.run(["git", "init", "-q", str(workspace)], env=git_environment,
                                   check=True, capture_output=True, timeout=5)
                allowed_marker, unlisted_marker = secrets.token_hex(24), secrets.token_hex(24)
                allowed.write_text(allowed_marker)
                unlisted.write_text(unlisted_marker)
                if directory_grant:
                    subprocess.run(["git", "-C", str(workspace), "check-ignore", "-q", "--", str(allowed)],
                                   env=git_environment, check=True, capture_output=True, timeout=5)
                server.command = "/bin/cat " + shlex.quote(str(allowed)) + " " + shlex.quote(str(unlisted))
                params = {"model": "gpt-5.6-sol", "modelProvider": "offline_fixture", "cwd": str(workspace),
                          "approvalPolicy": "on-request", "approvalsReviewer": "user",
                          "serviceTier": "default", "ephemeral": True}
                if restricted:
                    params.update(permissions="fixture_profile", config={"permissions": {"fixture_profile": {
                        "filesystem": {":minimal": "read", str(grant): "read"}, "network": {"enabled": False}}},
                        "tools": {"view_image": False}})
                else:
                    params["sandbox"] = "read-only"
                thread = client.call("thread/start", params)
                if restricted:
                    self.assertEqual(thread["activePermissionProfile"]["id"], "fixture_profile")
                turn = {"threadId": thread["thread"]["id"], "model": "gpt-5.6-sol", "cwd": str(workspace),
                        "approvalPolicy": "on-request", "approvalsReviewer": "user", "serviceTier": "default",
                        "outputSchema": {"type": "object", "properties": {"ok": {"type": "boolean"}},
                                         "required": ["ok"], "additionalProperties": False},
                        "input": [{"type": "text", "text": "Run the fixed offline fixture."}]}
                # A restricted turn inherits its already resolved thread policy.
                if not restricted:
                    turn["sandboxPolicy"] = {"type": "readOnly", "networkAccess": False}
                client.call("turn/start", turn)
                self.assertEqual(client.completed_turn()["status"], "completed")
                self.assertEqual(len(server.requests), 2)
                outputs = json.dumps(server.requests[1].get("input"), ensure_ascii=False)
                self.assertIn(allowed_marker, outputs)
                if restricted:
                    self.assertNotIn(unlisted_marker, outputs)
                    self.assertTrue("Operation not permitted" in outputs or "Permission denied" in outputs)
                else:
                    self.assertIn(unlisted_marker, outputs)

    def test_restricted_turn_inherits_read_paths(self):
        """Verify a file-scoped turn inherits its thread policy and cannot return an unlisted canary."""
        self.check_policy(True)

    def test_legacy_read_only_remains_broad(self):
        """Verify omitted explicit grants preserve the legacy broad read-only behavior."""
        self.check_policy(False)

    def test_directory_grant_includes_ignored_descendants(self):
        """Verify a directory grant covers ignored descendants while denying an outside sibling."""
        self.check_policy(True, directory_grant=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-binary", type=Path, required=True)
    args = parser.parse_args()
    BINARY = args.codex_binary.resolve(strict=True)
    with BINARY.open("rb") as executable:
        if executable.read(2) == b"#!":
            parser.error("Use the native Codex executable, not a launcher requiring the inherited PATH.")
    SCRATCH = Path(__file__).resolve().parent.parent / ".local-state/codex-read-policy-tests"
    SCRATCH.mkdir(parents=True, exist_ok=True, mode=0o700)
    unittest.main(argv=[__file__])
