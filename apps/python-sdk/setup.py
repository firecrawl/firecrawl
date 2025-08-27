import re
from pathlib import Path

from setuptools import find_packages, setup

this_directory = Path(__file__).parent
long_description_content = (this_directory / "README.md").read_text()


def get_version():
    """Dynamically set version"""
    version_file = (this_directory / "firecrawl" / "__init__.py").read_text()
    version_match = re.search(r"^__version__ = ['\"]([^'\"]*)['\"]", version_file, re.M)
    if version_match:
        return version_match.group(1)
    raise RuntimeError("Unable to find version string.")


setup(
    name="firecrawl-py",
    version=get_version(),
    url="https://github.com/firecrawl/firecrawl",
    author="Mendable.ai",
    author_email="nick@mendable.ai",
    description="Python SDK for Firecrawl API",
    long_description=long_description_content,
    long_description_content_type="text/markdown",
    packages=find_packages(),
    install_requires=[
        'requests',
        'pytest',
        'python-dotenv',
        'websockets',
        'asyncio',
        'nest-asyncio',
        'pydantic>=2.0',
        'aiohttp'
    ],
    python_requires=">=3.8",
    classifiers=[
        "Development Status :: 5 - Production/Stable",
        "Environment :: Web Environment",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: GNU General Public License v3 (GPLv3)",
        "Natural Language :: English",
        "Operating System :: OS Independent",
        "Programming Language :: Python",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Topic :: Internet",
        "Topic :: Internet :: WWW/HTTP",
        "Topic :: Internet :: WWW/HTTP :: Indexing/Search",
        "Topic :: Software Development",
        "Topic :: Software Development :: Libraries",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: Text Processing",
        "Topic :: Text Processing :: Indexing",
    ],
    keywords="SDK API firecrawl",
    project_urls={
        "Documentation": "https://docs.firecrawl.dev",
        "Source": "https://github.com/firecrawl/firecrawl",
        "Tracker": "https://github.com/firecrawl/firecrawl/issues",
    },
    license="GNU General Public License v3 (GPLv3)",
)
