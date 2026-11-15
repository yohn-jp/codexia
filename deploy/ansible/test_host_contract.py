import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("host_contract", Path(__file__).with_name("host-contract.py"))
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


class HostContractTest(unittest.TestCase):
    def test_matching_disjoint_ranges(self):
        contract.validate_ranges("alice:100000:65536\ncodexia:165536:65536\n", "codexia", 1001)

    def test_numeric_owner(self):
        contract.validate_ranges("1001:100000:65536\n", "codexia", 1001)

    def test_reject_missing_short_or_unsafe_ranges(self):
        for text in ("alice:100000:65536", "codexia:100000:65535",
                     "codexia:0:65536", "codexia:100000:65536\nalice:165535:65536",
                     "codexia:100000:65536\n1001:100001:65536", "codexia:bad:65536",
                     "codexia:4294967290:65536"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                contract.validate_ranges(text, "codexia", 1001)
