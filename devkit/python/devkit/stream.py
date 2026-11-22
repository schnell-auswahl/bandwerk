"""Line stream from the device for measurement tools.

Uses the bridge (devkit.bridge, http://127.0.0.1:8765/raw) when it is running,
because only one program can read the device's serial port at a time. Without
the bridge it opens the serial port directly.
"""
import glob, http.client, os, select, sys

BRIDGE_HOST, BRIDGE_PORT = "127.0.0.1", 8765
PORT_PATTERN = "/dev/cu.usbmodem*"


def find_port():
    ports = sorted(glob.glob(PORT_PATTERN))
    return ports[0] if ports else None


def _bridge_lines(stop, host, port):
    conn = http.client.HTTPConnection(host, port, timeout=2)
    conn.request("GET", "/raw")
    resp = conn.getresponse()
    if resp.status != 200:
        raise OSError("bridge refused")
    while not stop.is_set():
        try:
            line = resp.readline()
        except OSError:  # read timeout: just check the stop flag again
            continue
        if not line:
            return
        yield line.decode(errors="replace").rstrip("\r\n")


def _serial_lines(stop):
    path = find_port()
    if not path:
        sys.exit("no device serial port found (is it connected and running?)")
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    pending = b""
    try:
        while not stop.is_set():
            r, _, _ = select.select([fd], [], [], 0.2)
            if not r:
                continue
            try:
                pending += os.read(fd, 4096)
            except BlockingIOError:
                continue
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                yield line.decode(errors="replace").rstrip("\r")
    finally:
        os.close(fd)


def iter_lines(stop, host=BRIDGE_HOST, port=BRIDGE_PORT):
    """Yields log lines until `stop` (a threading.Event) is set."""
    try:
        yield from _bridge_lines(stop, host, port)
    except OSError:
        yield from _serial_lines(stop)
