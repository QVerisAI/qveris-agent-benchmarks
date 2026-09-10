"""Base runner contract."""

from __future__ import annotations

from abc import ABC, abstractmethod

from harness.models import AgentRunConfig, AgentRunResult, TaskSpec


class AgentRunner(ABC):
    name: str

    @abstractmethod
    def run(self, task: TaskSpec, config: AgentRunConfig) -> AgentRunResult:
        """Execute a benchmark task and return a normalized result."""

