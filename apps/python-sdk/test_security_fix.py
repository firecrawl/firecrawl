#!/usr/bin/env python3
"""
Simple test script to verify the AsyncHttpClient security fix.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from firecrawl.v2.utils.http_client_async import AsyncHttpClient


def test_security_fix():
    """Test the security fix for AsyncHttpClient."""
    print("Testing AsyncHttpClient security fix...")
    
    # Create client with API key
    client = AsyncHttpClient("test-api-key", "https://api.firecrawl.dev")
    
    # Test 1: Relative endpoint should include Authorization
    print("\n1. Testing relative endpoint...")
    headers = client._headers("/v2/scrape")
    if "Authorization" in headers:
        print("✅ Authorization header included for relative endpoint")
        print(f"   Header: {headers['Authorization']}")
    else:
        print("❌ Authorization header missing for relative endpoint")
        return False
    
    # Test 2: Same host absolute endpoint should include Authorization
    print("\n2. Testing same host absolute endpoint...")
    headers = client._headers("https://api.firecrawl.dev/v2/scrape")
    if "Authorization" in headers:
        print("✅ Authorization header included for same host")
        print(f"   Header: {headers['Authorization']}")
    else:
        print("❌ Authorization header missing for same host")
        return False
    
    # Test 3: Different host should NOT include Authorization
    print("\n3. Testing different host endpoint...")
    headers = client._headers("https://malicious.com/v2/scrape")
    if "Authorization" not in headers:
        print("✅ Authorization header correctly excluded for different host")
    else:
        print("❌ Authorization header incorrectly included for different host")
        print(f"   Header: {headers['Authorization']}")
        return False
    
    # Test 4: Subdomain should NOT include Authorization
    print("\n4. Testing subdomain endpoint...")
    headers = client._headers("https://api.firecrawl.dev.evil.com/v2/scrape")
    if "Authorization" not in headers:
        print("✅ Authorization header correctly excluded for subdomain")
    else:
        print("❌ Authorization header incorrectly included for subdomain")
        print(f"   Header: {headers['Authorization']}")
        return False
    
    # Test 5: Client without API key should not include Authorization
    print("\n5. Testing client without API key...")
    client_no_key = AsyncHttpClient(None, "https://api.firecrawl.dev")
    headers = client_no_key._headers("/v2/scrape")
    if "Authorization" not in headers:
        print("✅ Authorization header correctly excluded when no API key")
    else:
        print("❌ Authorization header incorrectly included when no API key")
        return False
    
    # Test 6: Client with empty API key should not include Authorization
    print("\n6. Testing client with empty API key...")
    client_empty = AsyncHttpClient("   ", "https://api.firecrawl.dev")
    headers = client_empty._headers("/v2/scrape")
    if "Authorization" not in headers:
        print("✅ Authorization header correctly excluded for empty API key")
    else:
        print("❌ Authorization header incorrectly included for empty API key")
        return False
    
    # Test 7: Idempotency key should be included regardless of host
    print("\n7. Testing idempotency key...")
    headers = client._headers("https://malicious.com/v2/scrape", idempotency_key="test-key")
    if "Authorization" not in headers and "x-idempotency-key" in headers:
        print("✅ Idempotency key included, Authorization correctly excluded")
    else:
        print("❌ Idempotency key or Authorization header issue")
        return False
    
    print("\n🎉 All security tests passed!")
    return True


if __name__ == "__main__":
    success = test_security_fix()
    sys.exit(0 if success else 1)
