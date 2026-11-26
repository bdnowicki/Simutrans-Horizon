"""
Tests of the token CLI of the bridge (simutrans_dashboard.py token add|list|revoke) as subprocesses.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import teamtestlib as T
from team import db as team_db


def cli(*args, env=None):
    p = subprocess.run([sys.executable, T.BRIDGE, "token"] + list(args), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=T.clean_env(env), timeout=60)
    return p.returncode, p.stdout, p.stderr


class TokenCliTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="team-cli-")
        self.db = os.path.join(self.dir, "agents.sqlite")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_add_list_revoke(self):
        code, out, err = cli("add", "--role", "player", "--company", "3", "--label", "Alice", "--db", self.db)
        self.assertEqual(code, 0, err)
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 2, out)
        self.assertIn("token 1: player, company 3, label Alice", lines[0])
        token = lines[1].strip()
        self.assertGreaterEqual(len(token), 32)
        db = team_db.TeamDB(self.db)
        try:
            self.assertEqual(db.lookup_token(token), {"id": 1, "role": "player", "company": 3, "label": "Alice"})
        finally:
            db.close()
        code, out, _ = cli("add", "--role", "viewer", "--db", self.db)
        self.assertEqual(code, 0)
        viewer = out.strip().splitlines()[1]
        code, out, err = cli("list", "--db", self.db)
        self.assertEqual(code, 0, err)
        self.assertNotIn(token, out)
        self.assertNotIn(viewer, out)
        self.assertNotIn(team_db.hash_token(token), out)
        rows = out.strip().splitlines()
        self.assertEqual(rows[0].split(), ["id", "role", "company", "label", "created", "revoked"])
        self.assertEqual(rows[1].split()[:4], ["1", "player", "3", "Alice"])
        self.assertEqual(rows[2].split()[:4], ["2", "viewer", "-", "-"])
        self.assertEqual(rows[1].split()[-1], "-")
        code, out, _ = cli("revoke", "1", "--db", self.db)
        self.assertEqual((code, out.strip()), (0, "token 1 revoked"))
        code, _, err = cli("revoke", "1", "--db", self.db)
        self.assertEqual(code, 1)
        self.assertIn("no active token", err)
        code, _, err = cli("revoke", "99", "--db", self.db)
        self.assertEqual(code, 1)
        code, out, _ = cli("list", "--db", self.db)
        self.assertNotEqual(out.strip().splitlines()[1].split()[-1], "-")  # revoked: a timestamp

    def test_refused_arguments(self):
        for args in (("add", "--role", "player"), ("add", "--role", "player", "--company", "1"),
                     ("add", "--role", "admin", "--company", "15"), ("add", "--role", "viewer", "--company", "0"),
                     ("add", "--role", "god", "--company", "0"), ("add", "--role", "player", "--company", "x")):
            code, out, err = cli(*(args + ("--db", self.db)))
            self.assertEqual(code, 2, (args, out, err))
            self.assertEqual(out, "")
        code, _, err = cli("add", "--role", "admin", "--company", "0")
        self.assertEqual(code, 2)
        self.assertIn("database file", err)
        code, _, _ = cli("list", "--db", ":memory:")
        self.assertEqual(code, 2)
        code, _, err = cli("list", "--db", os.path.join(self.dir, "missing.sqlite"))
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "missing.sqlite")))

    def test_env_database_path(self):
        code, out, err = cli("add", "--role", "admin", "--company", "0", env={"SIMUTRANS_DASHBOARD_DB": self.db})
        self.assertEqual(code, 0, err)
        code, out, _ = cli("list", env={"SIMUTRANS_DASHBOARD_DB": self.db})
        self.assertEqual(out.strip().splitlines()[1].split()[:3], ["1", "admin", "0"])


if __name__ == "__main__":
    unittest.main()
