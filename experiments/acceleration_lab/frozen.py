"""Read-only imports of frozen math without importing the production root entrypoint."""
from importlib import import_module
from pathlib import Path
import sys
import types


PACKAGE = "terry_accel_frozen"
ROOT = Path(__file__).resolve().parents[2]


def module(name):
    if PACKAGE not in sys.modules:
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(ROOT)]
        sys.modules[PACKAGE] = package
    return import_module(f"{PACKAGE}.{name}")


def refine_sigmas():
    return module("director_node")._refine_sigmas


def selflift_core():
    source = module("director_selflift")
    return source.ComfyBackend, source.sample_selflift
