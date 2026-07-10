#!/usr/bin/env python3
"""Render smoke tests for the supported NuQ deployment topologies."""

from pathlib import Path
import subprocess
import unittest

import yaml

CHART = Path(__file__).resolve().parents[1]
PREFIX = "smoke-firecrawl-"


def render(mode: str, *extra: str) -> list[dict]:
    command = ["helm", "template", "smoke", str(CHART), "--set", f"nuq.mode={mode}"]
    if mode != "pg":
        command += [
            "--set",
            "nuqFdb.clusterFile.existingSecret=fdb-cluster-file",
        ]
    command += list(extra)
    output = subprocess.run(command, check=True, capture_output=True, text=True)
    return [doc for doc in yaml.safe_load_all(output.stdout) if doc]


def deployments(documents: list[dict]) -> dict[str, dict]:
    return {
        doc["metadata"]["name"]: doc
        for doc in documents
        if doc.get("kind") == "Deployment"
    }


def config_map(documents: list[dict]) -> dict:
    return next(
        doc
        for doc in documents
        if doc.get("kind") == "ConfigMap"
        and doc["metadata"]["name"] == PREFIX + "config"
    )


class TopologySmokeTest(unittest.TestCase):
    def assert_worker_mode(
        self, deployment: dict, mode: str, executable: str
    ) -> None:
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        self.assertIn(executable, container["args"])
        env = {item["name"]: item.get("value") for item in container["env"]}
        self.assertEqual(env["NUQ_FDB_WORKER_MODE"], mode)
        self.assertEqual(env["NUQ_WORKER_PORT"], "3005")
        self.assertEqual(container["ports"], [{"containerPort": 3005}])
        self.assertEqual(
            container["livenessProbe"]["httpGet"],
            {"path": "/live", "port": 3005},
        )
        self.assertEqual(
            container["readinessProbe"]["httpGet"],
            {"path": "/ready", "port": 3005},
        )

    def assert_fdb_mount(self, deployment: dict) -> None:
        pod_spec = deployment["spec"]["template"]["spec"]
        mounts = pod_spec["containers"][0].get("volumeMounts", [])
        self.assertTrue(
            any(
                mount["name"] == "fdb-cluster-file"
                and mount["mountPath"] == "/etc/foundationdb"
                for mount in mounts
            )
        )
        volume = next(
            item for item in pod_spec["volumes"] if item["name"] == "fdb-cluster-file"
        )
        self.assertEqual(volume["secret"]["secretName"], "fdb-cluster-file")

    def assert_fdb_control_plane(self, rendered: dict[str, dict]) -> None:
        for role in ("maintenance", "crawl-finished"):
            name = f"{PREFIX}nuq-fdb-{role}-worker"
            deployment = rendered[name]
            self.assertGreaterEqual(deployment["spec"]["replicas"], 1)
            self.assert_worker_mode(
                deployment,
                role,
                "dist/src/services/worker/nuq-fdb-worker.js",
            )

    def test_pg_only(self) -> None:
        documents = render("pg")
        rendered = deployments(documents)
        self.assertIn(PREFIX + "nuq-worker", rendered)
        pg_container = rendered[PREFIX + "nuq-worker"]["spec"]["template"]["spec"][
            "containers"
        ][0]
        self.assertIn("dist/src/services/worker/nuq-worker.js", pg_container["args"])
        self.assertIn(PREFIX + "nuq-prefetch-worker", rendered)
        self.assertIn(PREFIX + "nuq-reconciler-worker", rendered)
        self.assertIn(PREFIX + "nuq-postgres", rendered)
        self.assertFalse(any("nuq-fdb" in name for name in rendered))
        config = config_map(documents)["data"]
        self.assertEqual(config["NUQ_BACKEND"], "pg")
        self.assertEqual(config["FDB_CLUSTER_FILE"], "")

    def test_mixed(self) -> None:
        documents = render(
            "mixed",
            "--set",
            "cclogWorker.enabled=true",
            "--set",
            "nuqPostgres.persistence.enabled=true",
        )
        rendered = deployments(documents)
        self.assertIn(PREFIX + "nuq-worker", rendered)
        self.assertIn(PREFIX + "nuq-fdb-scrape-worker", rendered)
        self.assert_worker_mode(
            rendered[PREFIX + "nuq-fdb-scrape-worker"],
            "scrape",
            "dist/src/services/worker/nuq-fdb-worker.js",
        )
        self.assertIn(PREFIX + "nuq-prefetch-worker", rendered)
        self.assertIn(PREFIX + "nuq-reconciler-worker", rendered)
        self.assertIn(PREFIX + "nuq-postgres", rendered)
        self.assert_fdb_control_plane(rendered)
        for workload in (
            "api",
            "worker",
            "extract-worker",
            "cclog-worker",
            "nuq-fdb-scrape-worker",
            "nuq-fdb-maintenance-worker",
            "nuq-fdb-crawl-finished-worker",
        ):
            self.assert_fdb_mount(rendered[PREFIX + workload])
        pvc = next(
            document
            for document in documents
            if document.get("kind") == "PersistentVolumeClaim"
        )
        self.assertEqual(
            pvc["metadata"]["annotations"]["helm.sh/resource-policy"], "keep"
        )
        config = config_map(documents)["data"]
        self.assertEqual(config["NUQ_BACKEND"], "")
        self.assertEqual(
            config["FDB_CLUSTER_FILE"], "/etc/foundationdb/fdb.cluster"
        )

    def test_forced_fdb_allows_zero_scrape_replicas(self) -> None:
        documents = render(
            "fdb", "--set", "nuqFdb.scrapeWorker.replicaCount=0"
        )
        rendered = deployments(documents)
        self.assertNotIn(PREFIX + "nuq-worker", rendered)
        self.assertNotIn(PREFIX + "nuq-prefetch-worker", rendered)
        self.assertNotIn(PREFIX + "nuq-reconciler-worker", rendered)
        self.assertNotIn(PREFIX + "nuq-postgres", rendered)
        self.assertEqual(rendered[PREFIX + "nuq-fdb-scrape-worker"]["spec"]["replicas"], 0)
        self.assert_fdb_control_plane(rendered)
        config = config_map(documents)["data"]
        self.assertEqual(config["NUQ_BACKEND"], "fdb")

    def assert_invalid_fdb_value(self, value: str, message: str) -> None:
        command = [
            "helm",
            "template",
            "smoke",
            str(CHART),
            "--set",
            "nuq.mode=fdb",
            "--set",
            "nuqFdb.clusterFile.existingSecret=fdb-cluster-file",
            "--set",
            value,
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)

    def test_fdb_control_plane_cannot_scale_to_zero(self) -> None:
        for worker in ("maintenanceWorker", "crawlFinishedWorker"):
            with self.subTest(worker=worker):
                self.assert_invalid_fdb_value(
                    f"nuqFdb.{worker}.replicaCount=0", "must be a positive integer"
                )

    def test_fdb_scrape_replicas_must_be_nonnegative_integers(self) -> None:
        for replicas in ("-1", "-0.5", "banana"):
            with self.subTest(replicas=replicas):
                self.assert_invalid_fdb_value(
                    f"nuqFdb.scrapeWorker.replicaCount={replicas}",
                    "must be a nonnegative integer",
                )


if __name__ == "__main__":
    unittest.main()
