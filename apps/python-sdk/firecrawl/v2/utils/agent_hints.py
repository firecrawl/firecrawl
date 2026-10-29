"""Preserve response guidance separately from extracted document content."""
from typing import Any, Dict, List


def agent_hint_metadata(body: Any) -> Dict[str, List[str]]:
    hints = body.get("agent_hints") if isinstance(body, dict) else None
    if isinstance(hints, list) and all(isinstance(hint, str) for hint in hints):
        return {"agent_hints": list(hints)}
    return {}
