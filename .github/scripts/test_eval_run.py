import argparse
import unittest

import requests

import eval_run


class Response:
    def __init__(self, status_code=200):
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"{self.status_code} error")


class EvalRunTests(unittest.TestCase):
    def args(self):
        return argparse.Namespace(
            api_url="https://eval.example",
            api_key="test-key",
            experiment_id="experiment",
            label="prod.sha",
        )

    def test_retries_connection_error_then_succeeds(self):
        calls = []
        sleeps = []

        def post(*args, **kwargs):
            calls.append((args, kwargs))
            if len(calls) == 1:
                raise requests.exceptions.ConnectionError(
                    "('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))"
                )
            return Response()

        response = eval_run.post_eval_run(self.args(), post=post, sleep=sleeps.append)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [eval_run.RETRY_BACKOFF_SECONDS[0]])
        self.assertEqual(calls[0][0][0], "https://eval.example/run")
        self.assertEqual(calls[0][1]["timeout"], eval_run.REQUEST_TIMEOUT_SECONDS)

    def test_persistent_connection_error_fails_after_max_attempts(self):
        calls = []

        def post(*args, **kwargs):
            calls.append((args, kwargs))
            raise requests.exceptions.ConnectionError("connection reset")

        with self.assertRaises(requests.exceptions.ConnectionError):
            eval_run.post_eval_run(self.args(), post=post, sleep=lambda _: None)

        self.assertEqual(len(calls), len(eval_run.RETRY_BACKOFF_SECONDS) + 1)

    def test_http_error_is_not_retried(self):
        calls = []

        def post(*args, **kwargs):
            calls.append((args, kwargs))
            return Response(status_code=500)

        response = eval_run.post_eval_run(self.args(), post=post, sleep=lambda _: None)

        with self.assertRaises(requests.exceptions.HTTPError):
            response.raise_for_status()

        self.assertEqual(len(calls), 1)

    def test_timeout_is_not_retried(self):
        calls = []

        def post(*args, **kwargs):
            calls.append((args, kwargs))
            raise requests.exceptions.Timeout("request timed out")

        with self.assertRaises(requests.exceptions.Timeout):
            eval_run.post_eval_run(self.args(), post=post, sleep=lambda _: None)

        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
