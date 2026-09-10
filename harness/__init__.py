"""QVeris Agent Harness.

Design scaffold for the repository-level orchestration layer. Today it ships a
typed data model (``harness.models``) and a structure-validation CLI
(``qveris-harness list-domains`` / ``validate``); the runner, scorer, adapter,
and report modules are unimplemented stubs. The runnable finance benchmark
lives at ``benchmarks/finance/qveris-finance-benchmark``. See the repository
README's Implementation Status section.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"

