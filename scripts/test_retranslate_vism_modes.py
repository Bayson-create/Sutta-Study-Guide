#!/usr/bin/env python3
"""Focused regression tests for the safe Vism retranslation queue modes."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


chapter = load("retranslate_vism_chapter")
queue = load("retranslate_vism_queue")
ROWS = [("p1-r1", "pali 1", "static", ""), ("p1-r2", "pali 2", "", ""), ("p1-r3", "pali 3", "", ""), ("p1-r4", "", "", "")]
OVERLAY = {
    "p1-r1": {"source": "dharmamitra", "current_text": "machine"},
    "p1-r2": {"source": "human", "current_text": "human"},
    "p1-r3": {"source": "other", "current_text": "other"},
}


class ModeSelectionTests(unittest.TestCase):
    def test_retranslate_selects_only_current_machine_rows(self):
        _all, todo, skipped, _span = chapter.select_rows(ROWS, OVERLAY, "retranslate-dharmamitra")
        self.assertEqual([row[0] for row in todo], ["p1-r1"])
        self.assertEqual(skipped, [])

    def test_human_rows_are_not_selected_in_any_mode(self):
        for mode in ("fill-gaps", "not-dharmamitra", "retranslate-dharmamitra"):
            _all, todo, _skipped, _span = chapter.select_rows(ROWS, OVERLAY, mode)
            self.assertNotIn("p1-r2", [row[0] for row in todo])

    def test_limit_applies_after_live_selection(self):
        overlay = {key: {"source": "dharmamitra", "current_text": "machine"} for key in ("p1-r1", "p1-r2", "p1-r3")}
        _all, todo, _skipped, _span = chapter.select_rows(ROWS, overlay, "retranslate-dharmamitra", limit=2)
        self.assertEqual([row[0] for row in todo], ["p1-r1", "p1-r2"])

    def test_queue_keeps_completed_chapters_first(self):
        self.assertEqual(queue.queue_steps("machine")[:3], [(1, "retranslate-dharmamitra"), (17, "retranslate-dharmamitra"), (18, "retranslate-dharmamitra")])
        self.assertEqual(queue.queue_steps("machine")[3:], [(11, "retranslate-dharmamitra"), (12, "retranslate-dharmamitra"), (15, "retranslate-dharmamitra"), (20, "retranslate-dharmamitra"), (21, "retranslate-dharmamitra"), (22, "retranslate-dharmamitra"), (23, "retranslate-dharmamitra")])


if __name__ == "__main__":
    unittest.main()
