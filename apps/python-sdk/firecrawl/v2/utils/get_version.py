import os
import re
from pathlib import Path

def get_version():
    try:
        package_path = Path(__file__).parents[2]
        version_file = (package_path / "__init__.py").read_text()
        version_match = re.search(r"^__version__ = ['\"]([^'\"]*)['\"]", version_file, re.M)
        if version_match:
            return version_match.group(1).strip()
        return "3.x.x"
    except Exception as e:
        print(f"Failed to get version from __init__.py: {e}")
        return "3.x.x"