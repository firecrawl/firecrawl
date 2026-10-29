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

python .github/scripts/check_version_has_incremented.py java ./apps/java-sdk com.firecrawl:firecrawl-java
Local version: 1.0.0
Published version: 0.0.0  (0.0.0 means not yet published on Maven Central)
true

python .github/scripts/check_version_has_incremented.py ruby ./apps/ruby-sdk firecrawl-sdk
Local version: 1.0.0
Published version: 0.0.0  (0.0.0 means not yet published on RubyGems)
true

python .github/scripts/check_version_has_incremented.py dotnet ./apps/dot-net-sdk/Firecrawl firecrawl-sdk
Local version: 1.0.0
Published version: 0.0.0  (0.0.0 means not yet published on NuGet)
true
python .github/scripts/check_version_has_incremented.py php ./apps/php-sdk firecrawl/firecrawl-sdk
Local version: 1.0.0
Published version: 0.0.0  (0.0.0 means not yet published on Packagist)
true
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

def get_gradle_version(file_path: str) -> str:
    """Extract version string from build.gradle.kts."""
    build_file = Path(file_path).read_text()
    version_match = re.search(r'^version\s*=\s*["\']([^"\']*)["\']', build_file, re.M)
    if version_match:
        return version_match.group(1).strip()
    raise RuntimeError("Unable to find version string in build.gradle.kts.")

def get_ruby_version(file_path: str) -> str:
    """Extract version string from Ruby version file (lib/firecrawl/version.rb)."""
    version_file = Path(file_path).read_text()
    version_match = re.search(r'VERSION\s*=\s*["\']([^"\']*)["\']', version_file, re.M)
    if version_match:
        return version_match.group(1).strip()
    raise RuntimeError("Unable to find version string in Ruby version file.")

def get_rubygems_version(package_name: str) -> str:
    """Get latest version of Ruby gem from RubyGems.org."""
    response = requests.get(f"https://rubygems.org/api/v1/versions/{package_name}/latest.json")
    if response.status_code == 404:
        return "0.0.0"
    version = response.json()['version']
    if version == "unknown":
        return "0.0.0"
    return version.strip()

def get_maven_central_version(package_name: str) -> str:
    """Get latest version of Java package from Maven Central. package_name should be groupId:artifactId."""
    group_id, artifact_id = package_name.split(":")
    group_path = group_id.replace(".", "/")
    url = f"https://repo1.maven.org/maven2/{group_path}/{artifact_id}/maven-metadata.xml"
    response = requests.get(url)
    if response.status_code == 404:
        return "0.0.0"
    response.raise_for_status()
    version_match = re.search(r"<release>(.*?)</release>", response.text)
    if not version_match:
        version_match = re.search(r"<latest>(.*?)</latest>", response.text)
    if version_match:
        return version_match.group(1).strip()
    return "0.0.0"

def get_csproj_version(file_path: str) -> str:
    """Extract version string from .csproj file."""
    csproj_file = Path(file_path).read_text()
    version_match = re.search(r'<Version>(.*?)</Version>', csproj_file)
    if version_match:
        return version_match.group(1).strip()
    raise RuntimeError("Unable to find version string in .csproj file.")

def get_nuget_version(package_name: str) -> str:
    """Get latest version of .NET package from NuGet."""
    url = f"https://api.nuget.org/v3-flatcontainer/{package_name.lower()}/index.json"
    response = requests.get(url)
    if response.status_code == 404:
        return "0.0.0"
    response.raise_for_status()
    versions = response.json().get('versions', [])
    if versions:
        return versions[-1].strip()
    return "0.0.0"

def get_php_version(file_path: str) -> str:
    """Extract version string from PHP Version.php file."""
    version_file = Path(file_path).read_text()
    version_match = re.search(r"SDK_VERSION\s*=\s*['\"]([^'\"]*)['\"]", version_file)
    if version_match:
        return version_match.group(1).strip()
    raise RuntimeError("Unable to find SDK_VERSION string in Version.php.")

def get_packagist_version(package_name: str) -> str:
    """Get latest version of PHP package from Packagist. package_name should be vendor/package."""
    url = f"https://packagist.org/packages/{package_name}.json"
    response = requests.get(url)
    if response.status_code == 404:
        return "0.0.0"
    response.raise_for_status()
    data = response.json()
    package_data = data.get("package", {})
    versions = package_data.get("versions", {})
    # Filter out dev versions and find highest stable version
    stable_versions = []
    for v in versions:
        normalized = v.lstrip("v")
        if "dev" in v or not re.match(r"^\d", normalized):
            continue
        try:
            parsed = parse_version(normalized)
        except Exception:
            continue
        if not parsed.is_prerelease:
            stable_versions.append(normalized)
    if not stable_versions:
        return "0.0.0"
    stable_versions.sort(key=lambda x: parse_version(x), reverse=True)
    return stable_versions[0]

def get_rust_version(file_path: str) -> str:
    """Extract version string from Cargo.toml."""
    import toml
    cargo_toml = toml.load(file_path)
    if 'package' in cargo_toml and 'version' in cargo_toml['package']:
        return cargo_toml['package']['version'].strip()
    raise RuntimeError("Unable to find version string in Cargo.toml.")

def get_crates_version(package_name: str) -> str:
    """Get latest version of Rust package from crates.io."""
    response = requests.get(
        f"https://crates.io/api/v1/crates/{package_name}",
        headers={"User-Agent": "firecrawl-version-check"}
    )
    if response.status_code == 404:
        return "0.0.0"
    response.raise_for_status()
    version = response.json()['crate']['newest_version']
    return version.strip()

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
    elif package_type == "java":
        # Get current version from build.gradle.kts
        current_version = get_gradle_version(os.path.join(package_path, 'build.gradle.kts'))
        # Get published version from Maven Central
        published_version = get_maven_central_version(package_name)
    elif package_type == "ruby":
        # Get current version from lib/firecrawl/version.rb
        current_version = get_ruby_version(os.path.join(package_path, 'lib', 'firecrawl', 'version.rb'))
        # Get published version from RubyGems
        published_version = get_rubygems_version(package_name)
    elif package_type == "dotnet":
        # Get current version from .csproj file — look for any .csproj in the directory
        csproj_files = list(Path(package_path).glob('*.csproj'))
        if not csproj_files:
            raise RuntimeError(f"No .csproj file found in {package_path}")
        current_version = get_csproj_version(str(csproj_files[0]))
        # Get published version from NuGet
        published_version = get_nuget_version(package_name)
    elif package_type == "php":
        # Get current version from src/Version.php
        current_version = get_php_version(os.path.join(package_path, 'src', 'Version.php'))
        # Get published version from Packagist
        published_version = get_packagist_version(package_name)
    elif package_type == "rust":
        # Get current version from Cargo.toml
        current_version = get_rust_version(os.path.join(package_path, 'Cargo.toml'))
        # Get published version from crates.io
        published_version = get_crates_version(package_name)

    else:
        raise ValueError("Invalid package type. Use 'python', 'js', 'java', 'ruby', 'rust', 'dotnet', or 'php'.")

    # Print versions for debugging
    # print(f"Local version: {current_version}")
    # print(f"Published version: {published_version}")

    # Compare versions and print result
    if is_version_incremented(current_version, published_version):
        print("true")
    else:
        print("false")
