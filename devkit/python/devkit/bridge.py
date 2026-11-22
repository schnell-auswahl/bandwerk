"""Bridge between the device's USB serial log and a browser live view.

It is the ONE program that opens the serial port (a port can only be used by a
single program). Everything else connects to this server instead:

  GET  /          your HTML page (with a static directory: its default page)
  GET  /<path>    files of the static directory, if one is given
  GET  /events    Server-Sent Events: lines parsed by your parse_line() as JSON
  GET  /raw       the raw lines as plain text (for measurement tools)
  GET  /state     JSON snapshot of the latest parsed state
  POST /cmd       send one text line to the device, answer = its reply line
                  (GET /cmd?c=... does the same)

Use it from a project wrapper:

    from devkit.bridge import main
    main(parse_line=my_parse_line, default_html="page.html")
    # or serve a whole folder (ES modules, CSS, fonts ...) and open one page of it:
    main(parse_line=my_parse_line, default_html="studio.html", static_dir="site")

parse_line(line) -> dict or None. A dict needs a "t" key (message type); the
types "S" and "SYS" are remembered and replayed to new browser clients, "log"
messages are kept in a short history. Only the standard library is used.
"""
import argparse, glob, json, mimetypes, os, queue, select, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

try:  # raw mode keeps the terminal layer from touching the bytes we write
    import termios, tty
except ImportError:  # pragma: no cover
    termios = tty = None


class Hub:
    """Fans every line out to all clients, remembers the latest state, and
    sends commands to the device."""

    def __init__(self, reply_prefix="[CMD]"):
        self.lock = threading.Lock()
        self.cmd_lock = threading.Lock()
        self.clients = []  # (kind, queue)
        self.last = {"status": {"t": "status", "connected": False}}
        self.log = []
        self.writer = None
        self.reply_prefix = reply_prefix

    def subscribe(self, kind):
        q = queue.Queue(maxsize=500)
        with self.lock:
            self.clients.append((kind, q))
            if kind == "events":
                for key in ("status", "S", "SYS"):
                    if key in self.last:
                        q.put(self.last[key])
                for line in self.log[-12:]:
                    q.put({"t": "log", "line": line})
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients = [(k, c) for k, c in self.clients if c is not q]

    @staticmethod
    def _put(q, item):
        try:
            q.put_nowait(item)
        except queue.Full:
            try:
                q.get_nowait()
                q.put_nowait(item)
            except queue.Empty:
                pass

    def publish_status(self, connected, writer=None):
        msg = {"t": "status", "connected": connected}
        with self.lock:
            self.last["status"] = msg
            self.writer = writer if connected else None
            for kind, q in self.clients:
                if kind == "events":
                    self._put(q, msg)

    def publish_line(self, line, parse_line):
        parsed = parse_line(line)
        with self.lock:
            for kind, q in self.clients:
                if kind == "raw":
                    self._put(q, line)
            if parsed is not None:
                if parsed.get("t") in ("S", "SYS"):
                    self.last[parsed["t"]] = parsed
                if parsed.get("t") == "log":
                    self.log.append(parsed["line"])
                    self.log = self.log[-50:]
                for kind, q in self.clients:
                    if kind == "events":
                        self._put(q, parsed)

    def send_command(self, text, timeout=1.5):
        """Sends one line to the device and returns its reply line (or None)."""
        with self.cmd_lock:  # one command at a time keeps replies unambiguous
            writer = self.writer
            if writer is None:
                raise ConnectionError("device not connected")
            q = self.subscribe("raw")
            try:
                writer((text.strip() + "\n").encode())
                end = time.time() + timeout
                while time.time() < end:
                    try:
                        line = q.get(timeout=max(0.05, end - time.time()))
                    except queue.Empty:
                        break
                    if line.startswith(self.reply_prefix):
                        return line
                return None
            finally:
                self.unsubscribe(q)


def serial_loop(hub, parse_line, device, port_pattern, stop):
    """Reads the device; reconnects when it disappears (reflash, unplug)."""
    while not stop.is_set():
        path = device or next(iter(sorted(glob.glob(port_pattern))), None)
        if not path or not os.path.exists(path):
            hub.publish_status(False)
            time.sleep(1.0)
            continue
        try:
            fd = os.open(path, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
        except OSError:
            hub.publish_status(False)
            time.sleep(1.0)
            continue
        if tty is not None:
            try:
                tty.setraw(fd)
            except termios.error:
                pass  # not a terminal (e.g. a plain pipe): fine

        def write(data, fd=fd):
            view = memoryview(data)
            deadline = time.time() + 1.0
            while view and time.time() < deadline:
                try:
                    n = os.write(fd, view)
                    view = view[n:]
                except BlockingIOError:
                    time.sleep(0.005)

        hub.publish_status(True, write)
        pending = b""
        try:
            while not stop.is_set():
                r, _, _ = select.select([fd], [], [], 0.5)
                if r:
                    try:
                        chunk = os.read(fd, 4096)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        break
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        text = line.decode(errors="replace").strip()
                        if text:
                            hub.publish_line(text, parse_line)
                elif device is None and not os.path.exists(path):
                    break
        except OSError:
            pass
        finally:
            os.close(fd)
        hub.publish_status(False)
        time.sleep(0.5)


# Content types for the static directory. ES modules must be served as JavaScript.
MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
    ".woff2": "font/woff2", ".woff": "font/woff", ".bin": "application/octet-stream",
    ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}


def content_type(path):
    ext = os.path.splitext(str(path))[1].lower()
    return MIME.get(ext) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def static_file(root, url_path):
    """Maps a URL path to a file inside root (None if outside or missing)."""
    root = Path(root).resolve()
    rel = url_path.lstrip("/")
    target = (root / rel).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return None  # ../ tricks
    if target.is_dir():
        target = target / "index.html"
    return target if target.is_file() else None


def make_handler(hub, html_path, static_dir=None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, ctype, body):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _command(self, text):
            try:
                reply = hub.send_command(text)
            except ConnectionError as e:
                self._send(503, "application/json", json.dumps({"ok": False, "reply": str(e)}).encode())
                return
            if reply is None:
                self._send(504, "application/json", json.dumps({"ok": False, "reply": "no reply from the device"}).encode())
                return
            text_reply = reply[len(hub.reply_prefix):].strip()
            self._send(200, "application/json",
                       json.dumps({"ok": text_reply.startswith("ok"), "reply": text_reply}).encode())

        def do_POST(self):
            if urlparse(self.path).path != "/cmd":
                self.send_error(404)
                return
            n = int(self.headers.get("Content-Length", 0))
            self._command(self.rfile.read(n).decode(errors="replace"))

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/" or (static_dir is None and url.path == "/index.html"):
                try:
                    self._send(200, "text/html; charset=utf-8", Path(html_path).read_bytes())
                except OSError:
                    self.send_error(404, "HTML page not found")
            elif url.path == "/state":
                with hub.lock:
                    body = json.dumps(hub.last).encode()
                self._send(200, "application/json", body)
            elif url.path == "/cmd":
                self._command(parse_qs(url.query).get("c", [""])[0])
            elif url.path in ("/events", "/raw"):
                kind = url.path[1:]
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if kind == "events"
                                 else "text/plain; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                q = hub.subscribe(kind)
                try:
                    while True:
                        try:
                            item = q.get(timeout=10)
                        except queue.Empty:
                            self.wfile.write(b": keep-alive\n\n" if kind == "events" else b"")
                            self.wfile.flush()
                            continue
                        if kind == "events":
                            self.wfile.write(b"data: " + json.dumps(item).encode() + b"\n\n")
                        else:
                            self.wfile.write(item.encode() + b"\n")
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    hub.unsubscribe(q)
            elif static_dir is not None and (f := static_file(static_dir, unquote(url.path))) is not None:
                try:
                    self._send(200, content_type(f), f.read_bytes())
                except OSError:
                    self.send_error(404)
            else:
                self.send_error(404)

    return Handler


def main(parse_line, default_html, port_pattern="/dev/cu.usbmodem*", reply_prefix="[CMD]", argv=None,
         static_dir=None):
    """default_html: the page served at "/". With static_dir, every file of that
    folder is served too and default_html may be a path relative to it."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--device", help="serial device (default: auto-detect)")
    ap.add_argument("--html", default=None, help="page served at / (default: %s)" % default_html)
    ap.add_argument("--static", default=str(static_dir) if static_dir else None,
                    help="folder served as static files (default: %(default)s)")
    a = ap.parse_args(argv)
    html = a.html or default_html
    if a.static and not Path(html).is_absolute():
        html = Path(a.static) / html

    hub = Hub(reply_prefix)
    stop = threading.Event()
    threading.Thread(target=serial_loop, args=(hub, parse_line, a.device, port_pattern, stop),
                     daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(hub, html, a.static))
    server.daemon_threads = True
    print(f"Bridge: http://localhost:{a.port}   (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
