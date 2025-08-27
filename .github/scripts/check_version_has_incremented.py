"""
checks local versions against published versions.

# Usage:

python .github/scripts/check_version_has_incremented.py js ./apps/js-sdk/firecrawl @mendable/firecrawl-js 
Local version: 0.0.22
Published version: 0.0.21
true

python .github/scripts/check_version_has_incremented.py python ./apps/python-sdk/firecrawl firecrawl-py 
Local version: 0.0.11
Published version: 0.0.11
false

"""
import json
import os
import re
import sys
from pathlib import Path

import requests
from packaging.version import Version
from packaging.version import parse as parse_version


def get_python_version(file_path: str) -> str:
    """Extract version string from Python file."""
    version_file = Path(file_path).read_text()
    version_match = re.search(r"^__version__ = ['\"]([^'\"]*)['\"]", version_file, re.M)
    if version_match:
        return version_match.group(1).strip()
    raise RuntimeError("Unable to find version string.")

def get_pypi_version(package_name: str) -> str:
    """Get latest version of Python package from PyPI."""
    response = requests.get(f"https://pypi.org/pypi/{package_name}/json")
    version = response.json()['info']['version']
    return version.strip()

def get_js_version(file_path: str) -> str:
    """Extract version string from package.json."""
    with open(file_path, 'r') as file:
        package_json = json.load(file)
    if 'version' in package_json:
        return package_json['version'].strip()
    raise RuntimeError("Unable to find version string in package.json.")

def get_npm_version(package_name: str) -> str:
    """Get latest version of JavaScript package from npm."""
    response = requests.get(f"https://registry.npmjs.org/{package_name}/latest")
    version = response.json()['version']
    return version.strip()

# def get_rust_version(file_path: str) -> str:
#     """Extract version string from Cargo.toml."""
#     cargo_toml = toml.load(file_path)
#     if 'package' in cargo_toml and 'version' in cargo_toml['package']:
#         return cargo_toml['package']['version'].strip()
#     raise RuntimeError("Unable to find version string in Cargo.toml.")

# def get_crates_version(package_name: str) -> str:
#     """Get latest version of Rust package from crates.io."""
#     response = requests.get(f"https://crates.io/api/v1/crates/{package_name}")
#     version = response.json()['crate']['newest_version']
#     return version.strip()

def is_version_incremented(local_version: str, published_version: str) -> bool:
    """Compare local and published versions."""
    local_version_parsed: Version = parse_version(local_version)
    published_version_parsed: Version = parse_version(published_version)
    return local_version_parsed > published_version_parsed

if __name__ == "__main__":
    package_type = sys.argv[1]
    package_path = sys.argv[2]
    package_name = sys.argv[3]

    if package_type == "python":
        # Get current version from __init__.py
        current_version = get_python_version(os.path.join(package_path, '__init__.py'))
        # Get published version from PyPI
        published_version = get_pypi_version(package_name)
    elif package_type == "js":
        # Get current version from package.json
        current_version = get_js_version(os.path.join(package_path, 'package.json'))
        # Get published version from npm
        published_version = get_npm_version(package_name)
    # if package_type == "rust":
    #     # Get current version from Cargo.toml
    #     current_version = get_rust_version(os.path.join(package_path, 'Cargo.toml'))
    #     # Get published version from crates.io
    #     published_version = get_crates_version(package_name)

    else:
        raise ValueError("Invalid package type. Use 'python' or 'js'.")

    # Print versions for debugging
    # print(f"Local version: {current_version}")
    # print(f"Published version: {published_version}")

    # Compare versions and print result
    if is_version_incremented(current_version, published_version):
        print("true")
    else:
        print("false")
