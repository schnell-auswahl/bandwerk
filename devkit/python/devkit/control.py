"""Send text commands to the device (development firmware).

Goes through the bridge (POST /cmd) when it is running, otherwise writes to the
serial port directly. A command is one line; the device answers with one line
that starts with the reply prefix (default "[CMD]"): "ok ..." or "err ...".
"""
import http.client, json, os, select, time

from devkit import stream


class ControlError(Exception):
    pass


class Control:
    def __init__(self, host=stream.BRIDGE_HOST, port=stream.BRIDGE_PORT, reply_prefix="[CMD]"):
        self.host, self.port, self.prefix = host, port, reply_prefix

    def send(self, line, timeout=3.0):
        """Returns the device's reply ("ok ..."); raises ControlError on "err ..." or no answer."""
        try:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
            conn.request("POST", "/cmd", body=line.encode())
            resp = conn.getresponse()
            data = json.loads(resp.read().decode() or "{}")
        except (ConnectionRefusedError, OSError):
            return self._send_serial(line, timeout)
        if not data.get("ok"):
            raise ControlError(f"{line!r}: {data.get('reply', 'failed')}")
        return data["reply"]

    def _send_serial(self, line, timeout):
        path = stream.find_port()
        if not path:
            raise ControlError("neither the bridge nor the device serial port is available")
        fd = os.open(path, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
        try:
            os.write(fd, (line.strip() + "\n").encode())
            end, pending = time.time() + timeout, b""
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.2)
                if not r:
                    continue
                try:
                    pending += os.read(fd, 4096)
                except BlockingIOError:
                    continue
                for raw in pending.split(b"\n"):
                    text = raw.decode(errors="replace").strip()
                    if text.startswith(self.prefix):
                        reply = text[len(self.prefix):].strip()
                        if not reply.startswith("ok"):
                            raise ControlError(f"{line!r}: {reply}")
                        return reply
            raise ControlError(f"{line!r}: no reply from the device")
        finally:
            os.close(fd)

    def state(self):
        """Latest parsed state from the bridge ({} if it is not running)."""
        try:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=2)
            conn.request("GET", "/state")
            return json.loads(conn.getresponse().read().decode())
        except (ConnectionRefusedError, OSError):
            return {}
