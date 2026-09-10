"""Core data contracts for benchmark tasks and evaluation results."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

RuntimeMode = Literal["baseline", "qveris_enabled"]


@dataclass(frozen=True)
class BenchmarkDomain:
    name: str
    root: Path


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    domain: str
    title: str
    prompt: str
    rubric_path: Path | None = None
    dataset_paths: list[Path] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentRunConfig:
    runner: str
    mode: RuntimeMode
    task_id: str
    timeout_seconds: int = 3600
    budget_usd: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentRunResult:
    task_id: str
    runner: str
    mode: RuntimeMode
    success: bool
    artifact_dir: Path | None = None
    elapsed_seconds: float | None = None
    cost_usd: float | None = None
    tool_calls: int = 0
    tool_success_rate: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Score:
    scorer: str
    value: float
    max_value: float = 1.0
    explanation: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
