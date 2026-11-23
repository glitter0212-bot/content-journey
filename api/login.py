import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
import _core  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def _run(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        status, headers, out = _core.handle_login(method, self.headers, body)
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        self._run("GET")

    def do_POST(self):
        self._run("POST")

    def do_DELETE(self):
        self._run("DELETE")
