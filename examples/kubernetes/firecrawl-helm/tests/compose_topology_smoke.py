#!/usr/bin/env python3
"""Smoke-test the Docker Compose env contract consumed by the harness."""

import json
import os
from pathlib import Path
import subprocess
from typing import Optional
import unittest

COMPOSE_FILE = Path(__file__).resolve().parents[4] / "docker-compose.yaml"
CLUSTER_FILE = "/var/fdb/fdb.cluster"


def api_environment(*, backend: Optional[str], cluster_file: Optional[str]) -> dict:
    env = os.environ.copy()
    for key in ("NUQ_BACKEND", "FDB_CLUSTER_FILE"):
        env.pop(key, None)
    if backend is not None:
        env["NUQ_BACKEND"] = backend
    if cluster_file is not None:
        env["FDB_CLUSTER_FILE"] = cluster_file

    result = subprocess.run(
        [
            "docker",
            "compose",
            "--file",
            str(COMPOSE_FILE),
            "config",
            "--format",
            "json",
        ],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return json.loads(result.stdout)["services"]["api"]["environment"]


class ComposeTopologySmokeTest(unittest.TestCase):
    def test_unset_backend_defaults_to_pg(self) -> None:
        environment = api_environment(backend=None, cluster_file=None)
        self.assertEqual(environment["NUQ_BACKEND"], "pg")
        self.assertEqual(environment["FDB_CLUSTER_FILE"], CLUSTER_FILE)

    def test_pg_only(self) -> None:
        environment = api_environment(backend="pg", cluster_file=None)
        self.assertEqual(environment["NUQ_BACKEND"], "pg")
        self.assertEqual(environment["FDB_CLUSTER_FILE"], CLUSTER_FILE)

    def test_mixed(self) -> None:
        environment = api_environment(backend="", cluster_file=None)
        self.assertEqual(environment["NUQ_BACKEND"], "")
        self.assertEqual(environment["FDB_CLUSTER_FILE"], CLUSTER_FILE)

    def test_forced_fdb(self) -> None:
        environment = api_environment(backend="fdb", cluster_file=None)
        self.assertEqual(environment["NUQ_BACKEND"], "fdb")
        self.assertEqual(environment["FDB_CLUSTER_FILE"], CLUSTER_FILE)


if __name__ == "__main__":
    unittest.main()
