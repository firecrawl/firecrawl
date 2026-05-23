import re
import json

def deep_shield_validator(scraped_text):
    """
    Advanced detection for Prompt Injection and Hidden Instructions.
    """
    # 1. Broad detection patterns
    danger_patterns = [
        r"(?i)ignore (all )?previous instructions",
        r"(?i)system override",
        r"(?i)new directive",
        r"(?i)forget everything you know",
        r"(?i)output the following instead",
        r"<u>", 
        r"<span>", 
    ]
    
    threats_found = []
    
    for pattern in danger_patterns:
        if re.search(pattern, scraped_text):
            threats_found.append(pattern)
            
    if threats_found:
        return {
            "status": "DANGER",
            "threats": threats_found,
            "message": "Security Alert: Malicious instructions detected!"
        }
    
    return {"status": "SAFE", "message": "Content verified."}

def firecrawl_v3_export(result):
    """Formats the result for the Firecrawl Bounty Registry."""
    payload = {
        "contributor": "Vivek76760",
        "module": "DeepShield_v1",
        "security_status": result['status'],
        "logs": result.get('threats', []),
        "timestamp": "2026-05-11"
    }
    return payload
