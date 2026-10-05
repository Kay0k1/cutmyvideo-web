"""Unit checks plus an opt-in, disposable real PostgreSQL integration.

CUTMY_DATABASE_TEST_CONTAINER must name an isolated container created for these
checks. The integration changes its bootstrap role; never point it at production.
CUTMY_DATABASE_TEST_CORE_BINARY optionally checks actual Go migrations too.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).with_name("database_access.py")
spec = importlib.util.spec_from_file_location("database_access", MODULE_PATH)
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)


class CredentialsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="cutmy-role-credentials-")
        self.addCleanup(self.directory.cleanup)
        self.shared = Path(self.directory.name)

    def test_private_credentials_reused_and_permissions_repaired(self):
        first = db.operator_credentials(self.shared)
        path = self.shared / "postgres-admin.env"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        path.chmod(0o644)
        second = db.operator_credentials(self.shared)
        self.assertTrue(first == second)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(first["POSTGRES_ADMIN_USER"], "cutmy_operator")
        self.assertEqual(len(first["POSTGRES_ADMIN_PASSWORD"]), 64)

    def test_reject_symlinks_and_malformed_credentials(self):
        target = self.shared / "target"
        target.write_text("not credentials")
        path = self.shared / "postgres-admin.env"
        path.symlink_to(target)
        with self.assertRaisesRegex(db.AccessError, "operator_credentials_invalid"):
            db.operator_credentials(self.shared)
        path.unlink()
        path.write_text("POSTGRES_ADMIN_PASSWORD=invalid\n")
        with self.assertRaisesRegex(db.AccessError, "operator_credentials_invalid"):
            db.operator_credentials(self.shared)
        self.assertEqual(target.read_text(), "not credentials")

    def test_private_lock_refuses_symlink(self):
        (self.shared / ".database-access.lock").symlink_to(self.shared / "missing")
        with self.assertRaises(OSError):
            with db.private_lock(self.shared):
                self.fail("symlink lock accepted")


class TransportTest(unittest.TestCase):
    def test_sql_is_stdin_only_and_driver_errors_are_secret_free(self):
        secret = "private-test-value"
        transport = db.PsqlTransport(Path("private.env"), Path("deploy"))
        captured = {}

        def run(command, **kwargs):
            captured.update(command=command, **kwargs)
            return subprocess.CompletedProcess(command, 1, "", "SQL PASSWORD " + secret)

        with mock.patch.object(db.subprocess, "run", run):
            with self.assertRaises(db.AccessError) as raised:
                transport.query("cutmy_operator", "ALTER ROLE example PASSWORD '" + secret + "';")
        self.assertNotIn(secret, str(captured["command"]))
        self.assertTrue(secret in captured["input"])
        self.assertNotIn(secret, str(raised.exception))
        self.assertNotIn("SQL", str(raised.exception))
        self.assertEqual(captured["timeout"], 60)
        self.assertIn("/var/run/postgresql", captured["command"])
        self.assertIn("-X", captured["command"])
        self.assertTrue(captured["input"].startswith("RESET ROLE;\nSET ROLE NONE;\nSET search_path=pg_catalog;"))
        self.assertIn(db.ADMIN_PGOPTIONS, captured["command"])

    def test_cli_has_machine_readable_status_and_safe_failure(self):
        result = {"ok": True, "bootstrap_changed": True, "restart_required": True,
                  "application_role": "cutmy", "operator_role": "cutmy_operator"}
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(db.DatabaseAccess, "run", return_value=result), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(db.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertEqual(errors.getvalue(), "")
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(db.DatabaseAccess, "run", side_effect=db.AccessError("database_command_failed")), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(db.main(), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue().strip(), "Database access hardening failed: database_command_failed")


@unittest.skipUnless(os.environ.get("CUTMY_DATABASE_TEST_CONTAINER"), "disposable PostgreSQL integration not requested")
class PostgreSQLIntegrationTest(unittest.TestCase):
    def test_bootstrap_ownership_recovery_permissions_and_go_migrations(self):
        container = os.environ["CUTMY_DATABASE_TEST_CONTAINER"]
        # An explicit name guard prevents accidental production-container use.
        self.assertTrue(container.startswith("cutmy-role-audit-"))
        temporary = tempfile.TemporaryDirectory(prefix="cutmy-pg-role-")
        self.addCleanup(temporary.cleanup)
        shared = Path(temporary.name)
        transport = db.PsqlTransport(container=container)
        access = db.DatabaseAccess(shared, transport)
        binary = os.environ.get("CUTMY_DATABASE_TEST_CORE_BINARY")
        script = """set -eu
export DATABASE_URL="postgres://cutmy:${POSTGRES_PASSWORD}@127.0.0.1:5432/cutmy?sslmode=disable"
export DATA_DIR=/tmp/cutmy-role-data
mkdir -p "$DATA_DIR"
/tmp/cutmy-role-core maintenance
/tmp/cutmy-role-core maintenance
"""
        if binary:
            subprocess.run(["docker", "cp", binary, container + ":/tmp/cutmy-role-core"], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            prior = subprocess.run(["docker", "exec", "-i", container, "sh"], input=script, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            self.assertEqual(prior.returncode, 0, "initial Go OpenStore failed under bootstrap fixture")
        q = transport.query
        self.assertEqual(q("cutmy", "SELECT oid FROM pg_roles WHERE rolname='cutmy';"), "10")
        q("cutmy", """
CREATE SCHEMA project;
CREATE DOMAIN project.positive AS integer CHECK(VALUE>0);
CREATE TYPE project.status AS ENUM('new','done');
CREATE TABLE project.sample(id serial PRIMARY KEY, value project.positive);
CREATE TABLE public.fixture(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
CREATE VIEW project.sample_view AS SELECT * FROM project.sample;
CREATE FUNCTION project.audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER audit_fixture BEFORE INSERT ON project.sample FOR EACH ROW EXECUTE FUNCTION project.audit_fixture();
CREATE FUNCTION project.add_one(value integer) RETURNS integer LANGUAGE sql AS $$SELECT value+1$$;
CREATE PROCEDURE project.procedure_fixture() LANGUAGE sql AS $$SELECT 1$$;
""")
        first = access.run()
        self.assertTrue(first["ok"] and first["bootstrap_changed"] and first["restart_required"])
        state = access.role_state()
        self.assertFalse(state["privileged"] or state["owns_catalogs"] or state["memberships"])
        self.assertNotEqual(state["oid"], 10)
        self.assertEqual(q("cutmy_operator", "SELECT oid FROM pg_roles WHERE rolname='cutmy_bootstrap';"), "10")
        self.assertEqual(q("cutmy_operator", "SELECT rolsuper AND NOT rolcanlogin AND rolpassword IS NULL FROM pg_authid WHERE rolname='cutmy_bootstrap';"), "t")
        self.assertEqual(q("cutmy_operator", "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='cutmy';"), "cutmy")
        self.assertEqual(q("cutmy_operator", """SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','project') AND pg_get_userbyid(c.relowner)<>'cutmy';"""), "0")
        self.assertEqual(q("cutmy_operator", "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='project' AND pg_get_userbyid(p.proowner)<>'cutmy';"), "0")
        self.assertEqual(q("cutmy_operator", "SELECT count(*) FROM pg_namespace WHERE nspname IN ('public','project') AND pg_get_userbyid(nspowner)<>'cutmy';"), "0")
        self.assertEqual(q("cutmy_operator", "SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='project' AND t.typtype IN ('d','e') AND pg_get_userbyid(t.typowner)<>'cutmy';"), "0")
        self.assertEqual(q("cutmy", "INSERT INTO project.sample(value) VALUES(1) RETURNING id;"), "1")
        self.assertEqual(q("cutmy", "SELECT project.add_one(2);"), "3")
        # Function/trigger replacement under the ordinary app owner is required
        # by the storage-ledger migration's CREATE OR REPLACE transaction.
        q("cutmy", """BEGIN; CREATE OR REPLACE FUNCTION project.audit_fixture() RETURNS trigger
LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; DROP TRIGGER audit_fixture ON project.sample;
CREATE TRIGGER audit_fixture BEFORE INSERT ON project.sample FOR EACH ROW EXECUTE FUNCTION project.audit_fixture(); COMMIT;""")
        for statement in ["COPY (SELECT 1) TO PROGRAM 'true';", "CREATE ROLE forbidden_role;",
                          "CREATE DATABASE forbidden_database;", "SELECT * FROM pg_authid;",
                          "SELECT pg_read_file('/etc/passwd');", "SET ROLE cutmy_operator;",
                          "SET ROLE cutmy_bootstrap;"]:
            with self.assertRaises(db.AccessError, msg=statement):
                q("cutmy", statement)
        first_credentials = db.operator_credentials(shared)
        # The DB owner can change defaults and create shadow catalog names.
        # Administrative queries must ignore both inherited search_path and
        # malicious user-schema relations while restoring least privilege.
        q("cutmy", "CREATE VIEW public.pg_roles AS SELECT * FROM pg_catalog.pg_roles WHERE false; ALTER DATABASE cutmy SET search_path=public,pg_catalog; ALTER DATABASE cutmy SET statement_timeout='1ms'; ALTER DATABASE cutmy SET lock_timeout='1ms'; ALTER DATABASE cutmy SET role=cutmy;")
        repeat = access.run()
        self.assertEqual(q("cutmy_operator", "SELECT current_user;"), "cutmy_operator")
        q("cutmy", "DROP VIEW public.pg_roles; ALTER DATABASE cutmy RESET search_path; ALTER DATABASE cutmy RESET statement_timeout; ALTER DATABASE cutmy RESET lock_timeout; ALTER DATABASE cutmy RESET role;")
        self.assertFalse(repeat["bootstrap_changed"] or repeat["restart_required"])
        self.assertTrue(first_credentials == db.operator_credentials(shared))
        # Losing the private file must not strand an already hardened service.
        # Local docker-root socket access restores the existing operator identity.
        (shared / "postgres-admin.env").unlink()
        recovered = access.run()
        self.assertTrue(recovered["ok"])
        recovered_credentials = db.operator_credentials(shared)
        self.assertFalse(first_credentials == recovered_credentials)
        # Verify the recovered private credential really authenticates over
        # SCRAM/TCP. The password is consumed from stdin, never command args.
        login = subprocess.run(["docker", "exec", "-i", container, "sh", "-c",
            "read -r PGPASSWORD; export PGPASSWORD; exec psql -X -q -A -t -h 127.0.0.1 -U cutmy_operator -d cutmy -c 'SELECT current_user;'"],
            input=recovered_credentials["POSTGRES_ADMIN_PASSWORD"] + "\n", text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertEqual(login.returncode, 0, "recovered operator authentication failed")
        self.assertEqual(login.stdout.strip(), "cutmy_operator")
        q("cutmy_operator", "ALTER ROLE cutmy SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS; GRANT pg_execute_server_program TO cutmy;")
        repaired = access.run()
        self.assertTrue(repaired["restart_required"])
        self.assertFalse(repaired["bootstrap_changed"])
        with self.assertRaises(db.AccessError):
            q("cutmy", "COPY (SELECT 1) TO PROGRAM 'true';")
        if binary:
            result = subprocess.run(["docker", "exec", "-i", container, "sh"], input=script, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            self.assertEqual(result.returncode, 0, "Go OpenStore/maintenance failed under ordinary app role")
            self.assertEqual(q("cutmy", "SELECT count(*) FROM public.app_schema_versions;"), "1")
            self.assertEqual(q("cutmy_operator", """SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND pg_get_userbyid(c.relowner)<>'cutmy';"""), "0")
            self.assertEqual(q("cutmy_operator", """SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND pg_get_userbyid(p.proowner)<>'cutmy';"""), "0")
            # Force the actual storage migration to run again: DDL replacement
            # and counter reconstruction must work after role separation too.
            q("cutmy", "DELETE FROM public.app_schema_versions;")
            result = subprocess.run(["docker", "exec", "-i", container, "sh"], input=script, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            self.assertEqual(result.returncode, 0, "repeated Go migration failed under ordinary app role")


if __name__ == "__main__":
    unittest.main()
