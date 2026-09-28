"""
Pytest configuration for the AI microservice.

`MIMIR_SKIP_DOTENV` is set here, before any test module imports `main`, so the
suite never inherits the developer's local `.env`. Without this, a machine
configured with e.g. `SYSTEM1_ENGINE=consensus` would fail tests that assert
the default-engine routing, making results machine-dependent.
"""

import os

os.environ["MIMIR_SKIP_DOTENV"] = "1"
