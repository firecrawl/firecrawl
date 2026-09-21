"""
Agent identity and authorization helpers.

Wraps the Bolyra SDK to provide a simple authorize-or-deny check
that can be dropped in front of any Firecrawl (or other API) call.

The Bolyra Python SDK shells out to @bolyra/sdk (Node.js) for ZK proof
generation, so Node.js 18+ and `npm install @bolyra/sdk` are required.
"""

import time
from dataclasses import dataclass
from typing import Optional

from bolyra import (
    Permission,
    create_human_identity,
    create_agent_credential,
    prove_handshake,
    verify_handshake,
    permissions_to_bitmask,
)


@dataclass
class AgentIdentity:
    """Bundle of operator + agent identities ready for authorization."""
    human: object
    agent: object
    permissions: list
    expiry: int


def create_agent_identity(
    operator_secret: int,
    model_hash: int = 12345,
    permissions: Optional[list] = None,
    ttl_seconds: int = 86400,
) -> AgentIdentity:
    """
    Create an operator identity and issue an agent credential.

    Args:
        operator_secret: Operator's private key (use a secure value in production).
        model_hash: Hash identifying the agent/model being credentialed.
        permissions: List of Permission flags. Defaults to READ_DATA + FINANCIAL_SMALL.
        ttl_seconds: Credential lifetime in seconds (default 24 h).

    Returns:
        AgentIdentity with both identities ready for authorize().
    """
    if permissions is None:
        permissions = [Permission.READ_DATA, Permission.FINANCIAL_SMALL]

    human = create_human_identity(operator_secret)
    expiry = int(time.time()) + ttl_seconds

    agent = create_agent_credential(
        model_hash=model_hash,
        operator_private_key=operator_secret,
        permissions=permissions,
        expiry_timestamp=expiry,
    )

    return AgentIdentity(human=human, agent=agent, permissions=permissions, expiry=expiry)


def authorize(identity: AgentIdentity) -> bool:
    """
    Run a ZK handshake to verify the agent's credential.

    Returns True if the agent is authorized, False otherwise.
    No secrets are revealed during verification.
    """
    try:
        handshake = prove_handshake(identity.human, identity.agent)
        verify_handshake(
            handshake.human_proof,
            handshake.agent_proof,
            handshake.session_nonce,
        )
        return True
    except Exception:
        return False
