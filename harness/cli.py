"""Command line entrypoint for repository validation and benchmark discovery."""

from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCHMARKS_DIR = ROOT / "benchmarks"


def list_domains() -> int:
    domains = sorted(path.name for path in BENCHMARKS_DIR.iterdir() if path.is_dir())
    for domain in domains:
        print(domain)
    return 0


def validate() -> int:
    required_domain_dirs = ("tasks", "datasets", "goldens", "rubrics")
    errors: list[str] = []

    if not BENCHMARKS_DIR.exists():
        errors.append(f"missing benchmarks directory: {BENCHMARKS_DIR}")
    else:
        for domain in sorted(path for path in BENCHMARKS_DIR.iterdir() if path.is_dir()):
            for child in required_domain_dirs:
                if not (domain / child).is_dir():
                    errors.append(f"missing {child} directory for domain {domain.name}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print("OK: benchmark structure is valid")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="qveris-harness")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list-domains", help="List benchmark domains")
    subparsers.add_parser("validate", help="Validate repository structure")
    args = parser.parse_args()

    if args.command == "list-domains":
        return list_domains()
    if args.command == "validate":
        return validate()
    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
