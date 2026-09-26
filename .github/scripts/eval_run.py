import requests
import argparse
import sys
import time

RETRY_BACKOFF_SECONDS = (5, 15)
REQUEST_TIMEOUT_SECONDS = 30


def post_eval_run(args, post=requests.post, sleep=time.sleep):
    last_error = None
    max_attempts = len(RETRY_BACKOFF_SECONDS) + 1

    for attempt in range(1, max_attempts + 1):
        try:
            return post(
                f"{args.api_url}/run",
                json={
                    "experiment_id": args.experiment_id,
                    "api_key": args.api_key,
                    "label": args.label
                },
                headers={
                    "Content-Type": "application/json"
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.exceptions.ConnectionError as e:
            last_error = e
            if attempt == max_attempts:
                break

            delay = RETRY_BACKOFF_SECONDS[attempt - 1]
            print(
                f"Eval API request failed on attempt {attempt}/{max_attempts}: {e}. "
                f"Retrying in {delay}s...",
                file=sys.stderr,
            )
            sleep(delay)

    raise last_error


def main():
    parser = argparse.ArgumentParser(description='Run evaluation benchmark')
    parser.add_argument('--label', required=True, help='Label for the evaluation run')
    parser.add_argument('--api-url', required=True, help='API URL')
    parser.add_argument('--api-key', required=True, help='API key')
    parser.add_argument('--experiment-id', required=True, help='Experiment ID')

    args = parser.parse_args()

    try:
        response = post_eval_run(args)

        response.raise_for_status()

        print("Evaluation run started successfully")
        print(f"Response: {response.json()}")

    except requests.exceptions.RequestException as e:
        print(f"Error running evaluation: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
