import http.client
import io
import json
import threading
import traceback
import urllib.error
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import timetracker_log as tracker


@pytest.fixture(autouse=True)
def dummy_auth(monkeypatch):
    monkeypatch.setattr(tracker, "_credentials", lambda _: ("http://127.0.0.1", "dummy-user", "dummy-agent-token"))
    monkeypatch.setattr(tracker, "_access_headers", lambda: {"CF-Access-Client-ID": "dummy-access-id", "CF-Access-Client-Secret": "dummy-access-secret"})


@contextmanager
def server(response):
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            # Closing with unread request bytes can reset POST and PATCH clients.
            self.request_body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            received.append((self.command, dict(self.headers)))
            response(self)

        do_POST = do_GET
        do_PATCH = do_GET

        def log_message(self, *args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{http.server_port}", received
    finally:
        http.shutdown()
        http.server_close()
        thread.join()


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_cross_origin_redirect_never_forwards_auth(monkeypatch, code, method):
    def ok(handler):
        handler.send_response(200)
        handler.end_headers()
        handler.wfile.write(b"{}")

    with server(ok) as (destination, forwarded):
        def redirect(handler):
            handler.send_response(code)
            handler.send_header("Location", destination + "/capture")
            handler.end_headers()

        with server(redirect) as (origin, received):
            monkeypatch.setattr(tracker, "_credentials", lambda _: (origin, "dummy-user", "dummy-agent-token"))
            with pytest.raises(RuntimeError, match=f"failed: {code}"):
                tracker._request(method, "/api/timesheets", "dummy", {"description": "task"} if method == "POST" else None)
            assert len(received) == 1
            assert received[0][1]["X-Auth-Token"] == "dummy-agent-token"
            assert received[0][1]["Cf-Access-Client-Secret"] == "dummy-access-secret"
        assert forwarded == []


@pytest.mark.parametrize("failure", [TimeoutError("timed out"), urllib.error.URLError(TimeoutError("timed out"))])
def test_timeout_is_finite_actionable_and_never_retries_post(monkeypatch, failure):
    calls = []

    def fail(self, request, timeout):
        calls.append((request.method, timeout))
        raise failure

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(RuntimeError, match="POST /api/timesheets unavailable: timed out"):
        tracker._request("POST", "/api/timesheets", "dummy", {"description": "task"})
    assert calls == [("POST", 20)]


def test_http_json_detail_redacts_credentials_and_bounds_the_read(monkeypatch):
    reads = []

    class BoundedBody(io.BytesIO):
        def read(self, size=-1):
            reads.append(size)
            return super().read(size)

    raw = json.dumps({"detail": "bad dummy-agent-token dummy-access-id dummy-access-secret"}).encode()

    def fail(self, request, timeout):
        raise urllib.error.HTTPError(request.full_url, 400, "bad", {}, BoundedBody(raw))

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(RuntimeError) as caught:
        tracker._request("PATCH", "/api/timesheets/42", "dummy", {"purpose": "invalid"})
    message = str(caught.value)
    assert "failed: 400 bad" in message
    assert message.count("[redacted]") == 3
    assert "dummy-agent-token" not in message
    assert "dummy-access-id" not in message
    assert "dummy-access-secret" not in message
    assert reads == [4097]
    assert caught.value.__suppress_context__


@pytest.mark.parametrize("body", [b"<html>dummy-agent-token</html>", b"x" * 10000, b'{"detail": ["dummy-agent-token"]}'])
def test_non_api_error_bodies_are_not_printed(monkeypatch, body):
    def fail(self, request, timeout):
        raise urllib.error.HTTPError(request.full_url, 502, "bad", {}, io.BytesIO(body))

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(RuntimeError) as caught:
        tracker._request("GET", "/api/timesheets", "dummy")
    assert str(caught.value) == "Time-tracker API GET /api/timesheets failed: 502"


def test_network_reason_is_redacted(monkeypatch):
    def fail(self, request, timeout):
        raise urllib.error.URLError("offline dummy-agent-token dummy-access-secret")

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(RuntimeError) as caught:
        tracker._request("GET", "/api/projects", "dummy")
    assert str(caught.value).endswith("unavailable: offline [redacted] [redacted]")


def test_success_payload_and_headers_are_preserved(monkeypatch):
    def ok(handler):
        handler.send_response(200)
        handler.end_headers()
        handler.wfile.write(b'{"id": 42}')

    with server(ok) as (origin, received):
        monkeypatch.setattr(tracker, "_credentials", lambda _: (origin, "dummy-user", "dummy-agent-token"))
        assert tracker._request("POST", "/api/timesheets", "dummy", {"description": "task"}) == {"id": 42}
        assert len(received) == 1
        assert received[0][1]["X-Auth-User"] == "dummy-user"


def test_response_read_timeout_is_redacted_and_not_retried(monkeypatch):
    calls = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self):
            raise TimeoutError("read deadline dummy-agent-token")

    def respond(self, request, timeout):
        calls.append(timeout)
        return Response()

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", respond)
    with pytest.raises(RuntimeError, match=r"unavailable: read deadline \[redacted\]"):
        tracker._request("POST", "/api/timesheets", "dummy", {"description": "task"})
    assert calls == [20]


def test_error_context_redacts_credentials_in_query(monkeypatch):
    def fail(self, request, timeout):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(RuntimeError) as caught:
        tracker._request("GET", "/api/timesheets?repo=dummy-agent-token", "dummy")
    assert "dummy-agent-token" not in str(caught.value)
    assert "repo=[redacted] unavailable: offline" in str(caught.value)


def test_fixture_consumes_complete_post_body_before_responding(monkeypatch):
    payload = {"description": "x" * 32768}

    def respond(handler):
        assert json.loads(handler.request_body) == payload
        handler.send_response(200)
        handler.end_headers()
        handler.wfile.write(b"{}")

    with server(respond) as (origin, received):
        monkeypatch.setattr(tracker, "_credentials", lambda _: (origin, "dummy-user", "dummy-agent-token"))
        assert tracker._request("POST", "/api/timesheets", "dummy", payload) == {}
        assert len(received) == 1


@pytest.mark.parametrize("field", ["X-AUTH-USER", "X-AUTH-TOKEN", "CF-Access-Client-ID", "CF-Access-Client-Secret"])
@pytest.mark.parametrize("suffix", ["\nfragment", "\rfragment", "\r\nfragment", "\r\n fragment", "\n\tfragment", "\u2603"])
def test_invalid_auth_headers_fail_before_request_without_exposing_values(monkeypatch, field, suffix):
    headers = {
        "X-AUTH-USER": "dummy-user",
        "X-AUTH-TOKEN": "dummy-agent-token",
        "CF-Access-Client-ID": "dummy-access-id",
        "CF-Access-Client-Secret": "dummy-access-secret",
    }
    value = "dummy-sensitive-fragment" + suffix
    headers[field] = value
    monkeypatch.setattr(tracker, "_credentials", lambda _: ("http://127.0.0.1", headers["X-AUTH-USER"], headers["X-AUTH-TOKEN"]))
    monkeypatch.setattr(tracker, "_access_headers", lambda: {name: value for name, value in headers.items() if name.startswith("CF-")})

    def unexpected(*args, **kwargs):
        pytest.fail("invalid authentication must fail before request construction or opening")

    monkeypatch.setattr(tracker.urllib.request, "Request", unexpected)
    monkeypatch.setattr(tracker.urllib.request, "build_opener", unexpected)
    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", unexpected)
    with pytest.raises(RuntimeError) as caught:
        tracker._request("GET", "/api/projects?credential=" + value, "dummy")
    assert str(caught.value) == "Time-tracker API GET /api/projects?credential=[redacted] invalid authentication configuration"
    assert caught.value.__suppress_context__
    assert caught.value.__context__ is None
    assert "dummy-sensitive-fragment" not in "".join(traceback.format_exception(caught.value))


@pytest.mark.parametrize("field", ["X-AUTH-USER", "X-AUTH-TOKEN", "CF-Access-Client-ID", "CF-Access-Client-Secret"])
@pytest.mark.parametrize("value", ["dummy-valid", " dummy-valid\t ", "dummy-\u00e9\u00ff"])
def test_valid_auth_header_values_are_preserved_offline(monkeypatch, field, value):
    headers = {
        "X-AUTH-USER": "dummy-user",
        "X-AUTH-TOKEN": "dummy-agent-token",
        "CF-Access-Client-ID": "dummy-access-id",
        "CF-Access-Client-Secret": "dummy-access-secret",
    }
    headers[field] = value
    monkeypatch.setattr(tracker, "_credentials", lambda _: ("http://127.0.0.1", headers["X-AUTH-USER"], headers["X-AUTH-TOKEN"]))
    monkeypatch.setattr(tracker, "_access_headers", lambda: {name: value for name, value in headers.items() if name.startswith("CF-")})
    calls = []

    def respond(self, request, timeout):
        calls.append((dict(request.header_items()), timeout))
        return io.BytesIO(b"{}")

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", respond)
    assert tracker._request("GET", "/api/projects", "dummy") == {}
    assert calls == [({
        **{name.capitalize(): value for name, value in headers.items()},
        "Content-type": "application/json",
        "User-agent": "Mozilla/5.0 (compatible; TimeTracker-Agent/1.0)",
    }, 20)]


@pytest.mark.parametrize("failure, expected", [
    (http.client.IncompleteRead(b"partial-body-SECRETPART", 10), "IncompleteRead(23 bytes read, 10 more expected)"),
    (http.client.BadStatusLine("HTTP/9 dummy-agent-token"), "HTTP/9 [redacted]"),
    (http.client.HTTPException("proto dummy-access-secret"), "proto [redacted]"),
    (ConnectionResetError("reset dummy-access-id"), "reset [redacted]"),
    (http.client.HTTPException("dummy-agent-token " + "x" * 499 + " dummy-access-secret " + "z" * 1000), "[redacted] " + "x" * 499 + " ["),
])
@pytest.mark.parametrize("method, path, body", [
    ("POST", "/api/timesheets", {"description": "task"}),
    ("PATCH", "/api/timesheets/42", {"purpose": "support"}),
])
def test_response_read_failures_are_sanitized_and_not_retried(monkeypatch, failure, expected, method, path, body):
    calls = []

    class Response(io.BytesIO):
        def read(self, size=-1):
            raise failure

    def respond(self, request, timeout):
        calls.append((request.method, timeout))
        return Response()

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", respond)
    with pytest.raises(RuntimeError) as caught:
        tracker._request(method, path, "dummy", body)
    context = f"Time-tracker API {method} {path} unavailable: "
    message = str(caught.value)
    assert message == context + expected
    assert len(message) <= len(context) + 512
    for leaked in ("SECRETPART", "dummy-agent-token", "dummy-access-id", "dummy-access-secret"):
        assert leaked not in message
    assert caught.value.__cause__ is None and caught.value.__suppress_context__
    assert calls == [(method, 20)]


@pytest.mark.parametrize("failure", [
    http.client.IncompleteRead(b"partial-detail-dummy-agent-token", 5),
    http.client.HTTPException("proto dummy-access-secret"),
    OSError("reset dummy-access-id"),
])
@pytest.mark.parametrize("method, path, body", [
    ("POST", "/api/timesheets", {"description": "task"}),
    ("PATCH", "/api/timesheets/42", {"purpose": "support"}),
])
def test_unreadable_http_error_body_preserves_status(monkeypatch, failure, method, path, body):
    calls, reads = [], []

    class Body(io.BytesIO):
        def read(self, size=-1):
            reads.append(size)
            raise failure

    def fail(self, request, timeout):
        calls.append((request.method, timeout))
        raise urllib.error.HTTPError(request.full_url, 503, "bad", {}, Body())

    monkeypatch.setattr(tracker.urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(RuntimeError) as caught:
        tracker._request(method, path, "dummy", body)
    assert str(caught.value) == f"Time-tracker API {method} {path} failed: 503"
    assert caught.value.__cause__ is None and caught.value.__suppress_context__
    assert calls == [(method, 20)]
    assert reads == [4097]
