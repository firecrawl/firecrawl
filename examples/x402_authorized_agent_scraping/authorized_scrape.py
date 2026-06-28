"""
Authorized Agent Scraping with x402 + Identity Verification

Demonstrates how to add an authorization layer before an AI agent
makes paid API calls (e.g., Firecrawl's x402 endpoint).

Problem: Any agent with a wallet can call x402 endpoints and spend money.
There's no built-in way to verify *which* agent is calling, or whether
that agent has permission to make financial API calls on behalf of its
operator.

Solution: Before the agent scrapes, it proves:
  1. It holds a valid operator-signed credential
  2. The credential includes FINANCIAL_SMALL permission (for paid APIs)
  3. The credential hasn't expired

The authorization check happens locally (zero-knowledge proof generation +
verification), so no extra network call or central auth server is needed.

Usage:
    pip install -r requirements.txt
    cp .env.example .env  # fill in your keys
    python authorized_scrape.py
"""

import os
import sys
import json
import time
from dataclasses import asdict
from dotenv import load_dotenv
from firecrawl import FirecrawlApp

# Bolyra provides the agent identity layer
from bolyra import (
    Permission,
    create_human_identity,
    create_agent_credential,
    prove_handshake,
    verify_handshake,
    permissions_to_bitmask,
)

# ANSI color codes for terminal output
class Colors:
    CYAN = '\033[96m'
    YELLOW = '\033[93m'
    GREEN = '\033[92m'
    RED = '\033[91m'
    MAGENTA = '\033[95m'
    BLUE = '\033[94m'
    RESET = '\033[0m'


def step(msg: str) -> None:
    """Print a step indicator."""
    print(f"{Colors.CYAN}[step]{Colors.RESET} {msg}")


def ok(msg: str) -> None:
    """Print a success indicator."""
    print(f"{Colors.GREEN}  [ok]{Colors.RESET} {msg}")


def fail(msg: str) -> None:
    """Print a failure indicator."""
    print(f"{Colors.RED}[fail]{Colors.RESET} {msg}")


# ---------------------------------------------------------------------------
# 1. Set up operator + agent identities (normally done once at deploy time)
# ---------------------------------------------------------------------------

def create_identities():
    """
    Create an operator (human) identity and an agent credential.

    In production:
    - The operator creates their identity once and stores the secret securely.
    - The operator issues agent credentials with specific permissions and expiry.
    - Agent credentials are deployed with the agent (e.g., as env vars or secrets).
    """
    step("Creating operator identity...")

    # Operator's secret (in production, use a secure random value or HSM)
    operator_secret = 42  # DO NOT use this in production
    human = create_human_identity(operator_secret)
    ok(f"Operator identity created (commitment: {str(human.commitment)[:16]}...)")

    step("Issuing agent credential with FINANCIAL_SMALL permission...")

    # The agent needs READ_DATA (to receive scrape results) and
    # FINANCIAL_SMALL (to authorize paid API calls under $100)
    permissions = [Permission.READ_DATA, Permission.FINANCIAL_SMALL]
    expiry = int(time.time()) + 86400  # Valid for 24 hours

    # Model hash identifies which model/agent is being credentialed
    model_hash = 12345  # In production, hash the model identifier

    agent = create_agent_credential(
        model_hash=model_hash,
        operator_private_key=operator_secret,
        permissions=permissions,
        expiry_timestamp=expiry,
    )
    ok(f"Agent credential issued (expires in 24h, permissions: {permissions_to_bitmask(permissions):#04x})")

    return human, agent


# ---------------------------------------------------------------------------
# 2. Authorization check — runs before any paid API call
# ---------------------------------------------------------------------------

def authorize_agent(human, agent):
    """
    Verify the agent is authorized to make financial API calls.

    This generates a zero-knowledge proof that:
    - The agent holds a valid credential signed by the operator
    - The credential includes the required permissions
    - The credential hasn't expired

    The proof reveals NOTHING about the operator's secret key or the
    agent's internal state — only that the authorization is valid.
    """
    step("Generating authorization proof (ZK handshake)...")

    try:
        handshake = prove_handshake(human, agent)
        ok("Proof generated")
    except Exception as e:
        fail(f"Proof generation failed: {e}")
        return None

    step("Verifying authorization proof...")

    try:
        result = verify_handshake(
            handshake.human_proof,
            handshake.agent_proof,
            handshake.session_nonce,
        )
        ok("Authorization verified — agent is permitted to make paid API calls")
        return result
    except Exception as e:
        fail(f"Authorization failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 3. Scrape with Firecrawl (only after authorization succeeds)
# ---------------------------------------------------------------------------

def scrape_with_firecrawl(url: str):
    """
    Scrape a URL using Firecrawl. This is the paid API call that the
    agent needs authorization for.
    """
    firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
    if not firecrawl_api_key:
        fail("FIRECRAWL_API_KEY not set. Set it in your .env file.")
        return None

    step(f"Scraping {url} via Firecrawl...")

    app = FirecrawlApp(api_key=firecrawl_api_key)
    result = app.scrape_url(url, params={"formats": ["markdown"]})

    ok(f"Scrape complete ({len(result.get('markdown', ''))} chars)")
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"\n{Colors.MAGENTA}=== Authorized Agent Scraping ==={Colors.RESET}")
    print("Demonstrates identity verification before paid API calls.\n")

    # Step 1: Create identities
    try:
        human, agent = create_identities()
    except Exception as e:
        fail(f"Identity creation failed: {e}")
        print(f"\n{Colors.YELLOW}Note: Identity creation requires @bolyra/sdk (Node.js).")
        print(f"See README.md for setup instructions.{Colors.RESET}")
        sys.exit(1)

    print()

    # Step 2: Authorize the agent
    auth_result = authorize_agent(human, agent)
    if auth_result is None:
        fail("Agent is NOT authorized. Blocking API call.")
        sys.exit(1)

    print()

    # Step 3: Only now make the paid scraping call
    url = input(f"{Colors.BLUE}Enter URL to scrape: {Colors.RESET}").strip()
    if not url:
        url = "https://firecrawl.dev"

    result = scrape_with_firecrawl(url)

    if result and result.get("markdown"):
        # Show a preview
        preview = result["markdown"][:500]
        print(f"\n{Colors.MAGENTA}--- Scrape Preview ---{Colors.RESET}")
        print(preview)
        if len(result["markdown"]) > 500:
            print(f"\n{Colors.YELLOW}... ({len(result['markdown']) - 500} more chars){Colors.RESET}")

    print(f"\n{Colors.GREEN}Done. The agent proved authorization before spending.{Colors.RESET}\n")


if __name__ == "__main__":
    load_dotenv()
    main()
