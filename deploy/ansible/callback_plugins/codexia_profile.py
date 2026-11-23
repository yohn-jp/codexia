"""Bounded CI-only Ansible task wall-time report (no task result data)."""

from time import monotonic
from ansible.plugins.callback import CallbackBase

DOCUMENTATION = """
name: codexia_profile
type: aggregate
short_description: Report the slowest lifecycle task wall times without task results
"""

class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "aggregate"
    CALLBACK_NAME = "codexia_profile"
    CALLBACK_NEEDS_ENABLED = True

    def __init__(self):
        super().__init__()
        self.current_name = None
        self.started = None
        self.timings = []

    def _finish(self):
        if self.started is not None:
            self.timings.append((round((monotonic() - self.started) * 1000), self.current_name))
            self.started = None

    def _start(self, task):
        self._finish()
        # Task names come from the checked-in playbook. Never inspect module
        # arguments, results, no_log payloads, or environment variables.
        self.current_name = task.get_name()[:120]
        self.started = monotonic()

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._start(task)

    def v2_playbook_on_handler_task_start(self, task):
        self._start(task)

    def v2_playbook_on_stats(self, stats):
        self._finish()
        for milliseconds, name in sorted(self.timings, reverse=True)[:20]:
            self._display.display(f"CODEXIA_ANSIBLE_TASK_TIME duration_ms={milliseconds} task={name}")
