"""The home guard in a Python child a test started (test/home-guard.ts).

Put on PYTHONPATH by the guard, so Python imports it at start-up, before the child's own code.
An audit hook refuses every write-shaped operation on a path inside the real home, the way the
Node guard wraps node:fs, and appends each refusal to the guard's refusals file, so the test
that started the child fails even when the child swallows the error or exits zero.
"""

import json
import os
import sys


def _install() -> None:
    homes = json.loads(os.environ.get("RELOAD_TEST_REAL_HOMES", "[]"))
    allowed = json.loads(os.environ.get("RELOAD_TEST_ALLOWED", "[]"))
    refusals = os.environ.get("RELOAD_TEST_REFUSALS")
    if not homes or refusals is None:
        return
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
    # The path arguments of each write-shaped audit event that change something.
    paths_of = {
        "os.mkdir": (0,),
        "os.remove": (0,),
        "os.rmdir": (0,),
        "os.rename": (0, 1),
        "os.symlink": (0, 1),
        "os.link": (0, 1),
        "os.truncate": (0,),
        "os.chmod": (0,),
        "os.chown": (0,),
        "os.utime": (0,),
        "shutil.rmtree": (0,),
        "shutil.copyfile": (1,),
        "shutil.copytree": (1,),
        "shutil.move": (0, 1),
    }

    def inside(target: str, root: str) -> bool:
        return target == root or target.startswith(root + os.sep)

    def in_real_home(argument: object) -> str | None:
        if not isinstance(argument, (str, bytes, os.PathLike)):
            return None  # a file descriptor: no path to judge
        target = os.path.abspath(os.fsdecode(argument))
        if any(inside(target, root) for root in allowed):
            return None
        return target if any(inside(target, root) for root in homes) else None

    def hook(event: str, args: tuple[object, ...]) -> None:
        if event == "open":
            path, mode, flags = args
            writes = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & write_flags != 0
            )
            targets = [path] if writes else []
        elif event in paths_of:
            targets = [args[index] for index in paths_of[event] if index < len(args)]
        else:
            return
        for argument in targets:
            target = in_real_home(argument)
            if target is not None:
                with open(refusals, "a", encoding="utf-8") as record:
                    record.write(f"python {event} {target} (child process {os.getpid()})\n")
                raise PermissionError(f"WriteToRealDirectory: a test tried to {event} {target}")

    sys.addaudithook(hook)


_install()
