"""Drive scripts/setup-free.mjs --dry-run in a real pseudo-terminal and check
the prompt stays visible, input is masked, Backspace works, and pasted text
with bracketed-paste markers is read correctly."""
import os, pty, select, sys, time

def read_until(fd, needle, timeout=10):
    buf = b""
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            buf += data
            if needle in buf:
                return buf
    return buf

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "scripts/setup-free.mjs", "--dry-run"])
out = read_until(fd, b"(Enter to skip): ")
ok = b"Paste your first secret" in out
os.write(fd, b"abcdef")
time.sleep(0.2)
os.write(fd, b"\x7f\x7fXY")   # two backspaces then XY -> "abcdXY"
time.sleep(0.2)
os.write(fd, b"\r")
out2 = read_until(fd, b"second secret (Enter to skip): ")
os.write(fd, b"\r")  # accidental Enter before pasting: must NOT skip
out2 += read_until(fd, b"press Enter again to skip: ")
os.write(fd, b"\x1b[200~gsk-pasted-value-123\x1b[201~")  # bracketed paste
time.sleep(0.2)
os.write(fd, b"\r")
out3 = read_until(fd, b"characters", timeout=5) + read_until(fd, b"characters", timeout=2)
os.waitpid(pid, 0)
screen = (out + out2 + out3).decode("utf8", "replace")
print(screen)
checks = {
    "prompt visible": "Paste your first secret (Enter to skip): " in screen,
    "input masked (no plaintext)": "abcd" not in screen and "gsk-pasted" not in screen and "XY" not in screen,
    "backspace handled": "received 6 characters" in screen,
    "bracketed paste read": "received 20 characters" in screen,
    "accidental Enter asks again": "Nothing pasted yet" in screen,
}
for k, v in checks.items():
    print(("PASS " if v else "FAIL ") + k)
sys.exit(0 if all(checks.values()) else 1)
