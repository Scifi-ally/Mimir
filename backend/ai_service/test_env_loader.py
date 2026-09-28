"""
Tests for the AI microservice's dependency-free `.env` loader and for the
LightGBM ranker's CRLF tolerance.
────────────────────────────────────────────────────────────────────────────
• The Node backend reads `.env`/`.env.local`; the Python tier previously read
  neither, so every `os.getenv(...)` in the AI service silently used a default.
• LightGBM's text model parser aborts the whole process on CRLF input, which is
  what a Windows `core.autocrlf=true` checkout produces.
"""

import os
import textwrap

import pytest

from env_loader import load_env_files, parse_env_file, resolve_env_paths


@pytest.fixture
def env_file(tmp_path):
    def _write(name: str, body: str) -> str:
        path = tmp_path / name
        path.write_text(textwrap.dedent(body), encoding="utf-8")
        return str(path)
    return _write


@pytest.fixture
def dotenv_enabled(monkeypatch):
    """conftest sets MIMIR_SKIP_DOTENV=1 for the session; clear it to test loading."""
    monkeypatch.delenv("MIMIR_SKIP_DOTENV", raising=False)
    return True


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def test_parse_env_file_basic_kinds(env_file):
    path = env_file(".env", """
        # a comment
        PLAIN=value

        export EXPORTED=exported_value
        QUOTED_DOUBLE="double quoted"
        QUOTED_SINGLE='single quoted'
        SPACED  =  trimmed
        WITH_COMMENT=keep_this # drop this
        EMPTY=
        NUMERIC=42
    """)
    parsed = parse_env_file(path)
    assert parsed["PLAIN"] == "value"
    assert parsed["EXPORTED"] == "exported_value"
    assert parsed["QUOTED_DOUBLE"] == "double quoted"
    assert parsed["QUOTED_SINGLE"] == "single quoted"
    assert parsed["SPACED"] == "trimmed"
    assert parsed["WITH_COMMENT"] == "keep_this"
    assert parsed["EMPTY"] == ""
    assert parsed["NUMERIC"] == "42"
    assert "a comment" not in parsed


def test_parse_env_file_skips_malformed_and_missing(tmp_path):
    path = tmp_path / ".env"
    path.write_text("GOOD=1\nthis is not an assignment\n9BAD=x\n", encoding="utf-8")
    parsed = parse_env_file(str(path))
    assert parsed == {"GOOD": "1"}
    # A nonexistent path is not an error.
    assert parse_env_file(str(tmp_path / "nope.env")) == {}


def test_parse_env_file_handles_bom_and_crlf(tmp_path):
    path = tmp_path / ".env"
    path.write_bytes(b"\xef\xbb\xbfSYSTEM1_ENGINE=consensus\r\nJEV_ENABLED=true\r\n")
    parsed = parse_env_file(str(path))
    assert parsed["SYSTEM1_ENGINE"] == "consensus"
    assert parsed["JEV_ENABLED"] == "true"


# ---------------------------------------------------------------------------
# Loading semantics
# ---------------------------------------------------------------------------

def test_load_env_files_applies_and_respects_precedence(env_file, monkeypatch, dotenv_enabled):
    base = env_file(".env", "SHARED=from_env\nONLY_ENV=env_value\n")
    local = env_file(".env.local", "SHARED=from_env_local\n")

    for key in ("SHARED", "ONLY_ENV", "ONLY_LOCAL"):
        monkeypatch.delenv(key, raising=False)

    applied = load_env_files([local, base])
    assert applied["SHARED"] == "from_env_local"  # .env.local wins
    assert applied["ONLY_ENV"] == "env_value"
    assert os.environ["ONLY_ENV"] == "env_value"
    monkeypatch.delenv("ONLY_ENV", raising=False)


def test_load_env_files_never_clobbers_real_process_env(env_file, monkeypatch, dotenv_enabled):
    base = env_file(".env", "PRESET=from_file\n")
    monkeypatch.setenv("PRESET", "from_container")

    load_env_files([base])
    # An explicit environment variable must beat a checked-in file.
    assert os.environ["PRESET"] == "from_container"

    load_env_files([base], override=True)
    assert os.environ["PRESET"] == "from_file"


def test_load_env_files_honours_skip_flag(env_file, monkeypatch):
    base = env_file(".env", "SHOULD_NOT_LOAD=nope\n")
    monkeypatch.setenv("MIMIR_SKIP_DOTENV", "1")
    monkeypatch.delenv("SHOULD_NOT_LOAD", raising=False)

    assert load_env_files([base]) == {}
    assert "SHOULD_NOT_LOAD" not in os.environ


def test_resolve_env_paths_lists_local_before_env():
    paths = resolve_env_paths(os.path.dirname(os.path.abspath(__file__)))
    names = [os.path.basename(p) for p in paths]
    # Every directory contributes .env.local before .env, mirroring the Node
    # side's override ordering.
    assert ".env.local" in names and ".env" in names
    assert names.index(".env.local") < names.index(".env")
    assert all(os.path.isabs(p) for p in paths)


# ---------------------------------------------------------------------------
# LightGBM CRLF tolerance
# ---------------------------------------------------------------------------

def test_ranker_model_loads_from_crlf_checkout(monkeypatch, tmp_path):
    """
    A CRLF-converted ranker model must still load.

    LightGBM aborts the process (STATUS_STACK_BUFFER_OVERRUN) on CRLF input, so
    the file must be normalized BEFORE the C++ loader is invoked — a try/except
    around the load is not enough because the abort is not catchable.
    """
    lightgbm = pytest.importorskip("lightgbm")
    from models import ranker_service

    real_model = ranker_service._MODEL_PATH
    if not os.path.isfile(real_model):
        pytest.skip("no trained ranker artifact in repo")

    with open(real_model, "r", encoding="utf-8", errors="replace", newline="") as fh:
        lf_text = fh.read().replace("\r\n", "\n").replace("\r", "\n")

    crlf_path = tmp_path / "ranker_model.txt"
    crlf_path.write_bytes(lf_text.replace("\n", "\r\n").encode("utf-8"))
    assert b"\r\n" in crlf_path.read_bytes(), "fixture must be genuinely CRLF"

    monkeypatch.setenv("RANKER_MODEL_PATH", str(crlf_path))
    monkeypatch.setattr(ranker_service, "_loaded", False, raising=False)
    monkeypatch.setattr(ranker_service, "_booster", None, raising=False)

    booster = ranker_service._load_booster(str(crlf_path))
    assert booster is not None
    assert booster.num_trees() > 0


def test_ranker_model_loads_from_lf_checkout(monkeypatch, tmp_path):
    """The happy path (LF) must keep working through the same helper."""
    pytest.importorskip("lightgbm")
    from models import ranker_service

    real_model = ranker_service._MODEL_PATH
    if not os.path.isfile(real_model):
        pytest.skip("no trained ranker artifact in repo")

    with open(real_model, "r", encoding="utf-8", errors="replace", newline="") as fh:
        lf_text = fh.read().replace("\r\n", "\n").replace("\r", "\n")

    lf_path = tmp_path / "ranker_model.txt"
    lf_path.write_text(lf_text, encoding="utf-8", newline="")
    assert b"\r\n" not in lf_path.read_bytes(), "fixture must be genuinely LF"

    booster = ranker_service._load_booster(str(lf_path))
    assert booster is not None
    assert booster.num_trees() > 0


def test_shipped_ranker_artifact_is_loadable():
    """The model committed to the repo must actually load."""
    pytest.importorskip("lightgbm")
    from models import ranker_service

    model_path = os.getenv("RANKER_MODEL_PATH", ranker_service._MODEL_PATH)
    if not os.path.isfile(model_path):
        pytest.skip("no trained ranker artifact in repo")

    booster = ranker_service._load_booster(model_path)
    assert booster.num_trees() > 0
