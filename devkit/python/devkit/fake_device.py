"""A fake device on a pseudo terminal, for testing bridges, tools and pages
without hardware. Write what the firmware would print, read what the host sends.

    dev = PtyDevice()
    print(dev.path)             # give this to: bridge --device <path>
    dev.send("[L] in=-300 ...")
    for line in dev.read_lines(): ...   # commands written by the host
"""
import os, pty, select, tty


class PtyDevice:
    def __init__(self):
        self.master, slave = pty.openpty()
        tty.setraw(self.master)
        self.path = os.ttyname(slave)
        self._slave = slave  # keep it open so the pty stays alive
        self._buf = b""

    def send(self, text):
        os.write(self.master, (text + "\r\n").encode())

    def read_lines(self):
        """Complete lines received from the host since the last call."""
        out = []
        while select.select([self.master], [], [], 0)[0]:
            try:
                self._buf += os.read(self.master, 4096)
            except OSError:
                break
        while b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            text = line.decode(errors="replace").strip()
            if text:
                out.append(text)
        return out
