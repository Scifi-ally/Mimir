"""
Dependency-free `.env` / `.env.local` loader for the AI microservice.
─────────────────────────────────────────────────────────────────────────────
The Node backend loads `.env.local` and `.env` through `dotenv`, but this
Python service previously loaded neither. Every `os.getenv(...)` in the AI
tier — `SYSTEM1_ENGINE`, `TYPESAFE_API_KEY`, `RANKER_MODEL_PATH`,
`DATABASE_URL`, `HF_HUB_OFFLINE`, `RANKER_MIN_THRESHOLD` — therefore silently
fell back to its default, so the configuration an operator writes in `.env`
had no effect on the inference service at all.

Precedence matches the Node side (see `backend/db/src/index.ts`):
  1. Already-set process environment variables always win (explicit overrides).
  2. `.env.local` overrides `.env`.
  3. Earlier files do not clobber later-loaded ones.

No third-party dependency: `python-dotenv` is not in requirements.txt and the
service must still import in a zero-dependency install.
"""

from __future__ import annotations

import os
import re
from typing import Dict, Iterable, List, Optional

_LINE_RE = re.compile(
    r"""^\s*
    (?:export\s+)?                      # optional `export ` prefix
    (?P<key>[A-Za-z_][A-Za-z0-9_.\-]*)\s*=\s*
    (?P<value>.*?)
    \s*$
    """,
    re.VERBOSE,
)

_TRUE = {"true", "1", "yes", "on"}
_FALSE = {"false", "0", "no", "off"}


def parse_env_file(path: str) -> Dict[str, str]:
    """Parse a dotenv-style file. Malformed lines are skipped, never fatal."""
    out: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            raw_lines = fh.readlines()
    except (OSError, UnicodeError):
        return out

    for raw in raw_lines:
        line = raw.rstrip("\r\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue

        match = _LINE_RE.match(line)
        if not match:
            continue

        key = match.group("key")
        value = match.group("value").strip()

        if value[:1] in ("'", '"'):
            # Match a leading quote against its closing quote wherever it sits, so
            # a trailing comment does not defeat the check. Testing only
            # `value[-1]` left literal quotes in the value: Node's dotenv would
            # yield `abc123`, we would yield `"abc123"`, and the Authorization
            # header would become `Bearer "abc123"` -> HTTP 401 -> the Jev circuit
            # breaker opens permanently.
            quote = value[0]
            close = value.find(quote, 1)
            if close != -1:
                value = value[1:close]
                if quote == '"':
                    # Only the double-quoted form honours escapes, matching dotenv.
                    value = (
                        value.replace("\\n", "\n")
                        .replace("\\t", "\t")
                        .replace('\\"', '"')
                    )
            else:
                value = value.lstrip(quote)
        else:
            # Unquoted values end at an unescaped ` #` comment.
            hash_pos = value.find(" #")
            if hash_pos != -1:
                value = value[:hash_pos].rstrip()

        out[key] = value
    return out


def _coerce_env_value(value: str) -> str:
    """Expand a leading `~` so user-relative artifact paths work."""
    if value.startswith("~"):
        return os.path.expanduser(value)
    return value


def load_env_files(paths: Iterable[str], override: bool = False) -> Dict[str, str]:
    """
    Load dotenv files into os.environ.

    Keys already present in os.environ are preserved unless `override` is set,
    so a real environment variable (e.g. set by a container or CI) always beats
    a checked-in file.

    Set `MIMIR_SKIP_DOTENV=1` to disable loading entirely. The test suite uses
    this so results never depend on the developer's local `.env`.
    """
    if os.getenv("MIMIR_SKIP_DOTENV", "").strip().lower() in _TRUE:
        return {}

    applied: Dict[str, str] = {}
    for path in paths:
        if not path or not os.path.isfile(path):
            continue
        for key, value in parse_env_file(path).items():
            if not override and key in os.environ:
                continue
            coerced = _coerce_env_value(value)
            os.environ[key] = coerced
            applied[key] = coerced
    return applied


def resolve_env_paths(app_dir: Optional[str] = None) -> List[str]:
    """
    Build the ordered candidate path list for the AI service.

    Walks up from this file so the loader works whether the service is started
    from the repo root (`uvicorn main:app --app-dir backend/ai_service`) or from
    inside `backend/ai_service`. `.env.local` is listed first because it wins.

    The walk is capped at the repository root (the first ancestor containing a
    `.git` directory, or `backend/`). It deliberately does NOT continue into the
    user's home directory: a `~/.env` is a common place to stash credentials,
    and silently applying one to a live trading service is a security hazard.
    """
    here = os.path.abspath(app_dir or os.path.dirname(os.path.abspath(__file__)))

    seen = set()
    candidates: List[str] = []
    node = here
    for _ in range(4):  # bounded walk: ai_service -> backend -> repo -> parent
        if node in seen:
            break
        seen.add(node)
        for name in (".env.local", ".env"):
            candidate = os.path.join(node, name)
            if candidate not in candidates:
                candidates.append(candidate)

        # Stop after examining the repository root.
        if os.path.isdir(os.path.join(node, ".git")) or os.path.isdir(os.path.join(node, "backend")):
            break

        parent = os.path.dirname(node)
        if parent == node:
            break
        node = parent
    return candidates
