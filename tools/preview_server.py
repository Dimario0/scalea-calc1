"""Local demonstration only: production entry and network connections are blocked."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {"preview.html", "app.js", "data.js", "preview-store.js", "web_ready_bg.jpg", "ui.css"}


class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        name = urlsplit(self.path).path.lstrip("/") or "preview.html"
        if name not in ALLOWED:
            self.send_error(404)
            return
        self.path = "/" + name
        super().do_GET()

    def do_HEAD(self):
        name = urlsplit(self.path).path.lstrip("/") or "preview.html"
        if name not in ALLOWED:
            self.send_error(404)
            return
        self.path = "/" + name
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "connect-src 'none'; object-src 'none'; base-uri 'self'")
        super().end_headers()


if __name__ == "__main__":
    print("ScaleaStay preview: http://127.0.0.1:8765/preview.html", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8765), PreviewHandler).serve_forever()
