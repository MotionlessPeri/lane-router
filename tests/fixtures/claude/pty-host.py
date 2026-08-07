import os
import sys
import threading

from winpty import PtyProcess


def forward_input(process: PtyProcess) -> None:
    while process.isalive():
        data = sys.stdin.buffer.read(1)
        if not data:
            return
        process.write(data.decode("utf-8"))


process = PtyProcess.spawn(sys.argv[1:], cwd=os.getcwd(), env=os.environ.copy(), dimensions=(40, 120))
threading.Thread(target=forward_input, args=(process,), daemon=True).start()
try:
    while process.isalive():
        try:
            output = process.read(4096)
        except EOFError:
            break
        if output:
            sys.stdout.write(output)
            sys.stdout.flush()
finally:
    if process.isalive():
        process.terminate(force=True)
    process.wait()
sys.exit(process.exitstatus or 0)
