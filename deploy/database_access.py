#!/usr/bin/env python3
"""Separate the application login from PostgreSQL's bootstrap administrator.

Credentials live beside production.env, never in application environment or SQL
arguments. The original Docker POSTGRES_USER is often bootstrap OID 10: PostgreSQL
requires that role to stay superuser. Rename it to a NOLOGIN catalog owner, create
a new ordinary application login, and transfer only project objects.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import subprocess
import tempfile
import time

APP_ROLE = "cutmy"
APP_DATABASE = "cutmy"
OPERATOR_ROLE = "cutmy_operator"
BOOTSTRAP_ROLE = "cutmy_bootstrap"
HARDENING_LOCK = 736021912360109
ADMIN_PGOPTIONS = "PGOPTIONS=-c search_path=pg_catalog -c statement_timeout=45s -c lock_timeout=10s -c idle_session_timeout=0 -c idle_in_transaction_session_timeout=0"


class AccessError(RuntimeError):
    """Only fixed, secret-free diagnostic codes may cross the CLI boundary."""


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class PsqlTransport:
    def __init__(self, env_file: Path | None = None,
                 deploy_dir: Path | None = None, *, container: str | None = None):
        if container:
            self.prefix = ["docker", "exec", "-i", "-e", ADMIN_PGOPTIONS, container]
        else:
            self.prefix = ["docker", "compose", "--env-file", str(env_file),
                           "-f", str(deploy_dir / "compose.yaml"), "exec", "-T", "-e", ADMIN_PGOPTIONS, "postgres"]

    def query(self, role: str, sql: str) -> str:
        command = self.prefix + ["psql", "-X", "-q", "-A", "-t", "-h",
                                 "/var/run/postgresql", "-U", role,
                                 "-d", APP_DATABASE, "-v", "ON_ERROR_STOP=1"]
        # The ordinary application owns its database and can change its
        # default search_path. Do not let user-schema objects shadow catalog
        # views/functions while these statements run as an administrator.
        sql = "RESET ROLE;\nSET ROLE NONE;\nSET search_path=pg_catalog;\nSET standard_conforming_strings=on;\n" + sql
        try:
            result = subprocess.run(command, input=sql, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=60, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise AccessError("database_transport_unavailable") from exc
        # PostgreSQL can echo the failing SQL (including PASSWORD literals).
        # Never return stderr, command text, or exception details to the caller.
        if result.returncode or len(result.stdout) > 65536:
            raise AccessError("database_command_failed")
        return result.stdout.strip()


@contextlib.contextmanager
def private_lock(shared_dir: Path):
    shared_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = shared_dir / ".database-access.lock"
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        os.close(descriptor)
        raise AccessError("database_access_lock_invalid")
    os.fchmod(descriptor, 0o600)
    deadline = time.monotonic() + 30
    try:
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise AccessError("database_access_busy")
                time.sleep(0.1)
        yield
    finally:
        os.close(descriptor)


def operator_credentials(shared_dir: Path) -> dict[str, str]:
    path = shared_dir / "postgres-admin.env"
    if path.exists() or path.is_symlink():
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError as exc:
            raise AccessError("operator_credentials_invalid") from exc
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                raise AccessError("operator_credentials_invalid")
            if info.st_uid != os.geteuid():
                raise AccessError("operator_credentials_owner_invalid")
            os.fchmod(handle.fileno(), 0o600)
            contents = handle.read(4097)
            if len(contents) > 4096:
                raise AccessError("operator_credentials_invalid")
        values = {}
        for line in contents.splitlines():
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or key in values:
                raise AccessError("operator_credentials_invalid")
            values[key] = value
        if (values.get("POSTGRES_ADMIN_USER") != OPERATOR_ROLE or
                values.get("POSTGRES_ADMIN_DATABASE") != APP_DATABASE or
                set(values) != {"POSTGRES_ADMIN_USER", "POSTGRES_ADMIN_PASSWORD", "POSTGRES_ADMIN_DATABASE"} or
                not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", values.get("POSTGRES_ADMIN_PASSWORD", ""))):
            raise AccessError("operator_credentials_invalid")
        return values
    values = {"POSTGRES_ADMIN_USER": OPERATOR_ROLE,
              "POSTGRES_ADMIN_PASSWORD": secrets.token_urlsafe(48),
              "POSTGRES_ADMIN_DATABASE": APP_DATABASE}
    descriptor, temporary = tempfile.mkstemp(prefix=".postgres-admin.", dir=shared_dir)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            for key, value in values.items():
                handle.write(key + "=" + value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(shared_dir, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return values


class DatabaseAccess:
    def __init__(self, shared_dir: Path, transport: PsqlTransport):
        self.shared_dir = shared_dir
        self.transport = transport

    def role_is_admin(self, role: str) -> bool:
        try:
            return self.transport.query(role, "SELECT rolsuper FROM pg_roles WHERE rolname=" + sql_literal(role) + ";") == "t"
        except AccessError:
            return False

    def role_state(self) -> dict:
        raw = self.transport.query(OPERATOR_ROLE, f"""
SELECT json_build_object(
 'exists',EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{APP_ROLE}'),
 'oid',(SELECT oid FROM pg_roles WHERE rolname='{APP_ROLE}'),
 'privileged',EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{APP_ROLE}' AND
   (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)),
 'owns_catalogs',EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='{APP_ROLE}' AND n.nspname='pg_catalog'),
 'memberships',EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='{APP_ROLE}')
);""")
        try:
            state = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise AccessError("database_identity_invalid") from exc
        if not isinstance(state, dict):
            raise AccessError("database_identity_invalid")
        return state

    def configure_operator(self, actor: str, password: str) -> None:
        self.transport.query(actor, f"""
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock({HARDENING_LOCK});
DO $create_operator$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{OPERATOR_ROLE}') THEN
  CREATE ROLE {OPERATOR_ROLE} LOGIN SUPERUSER;
 END IF;
END $create_operator$;
ALTER ROLE {OPERATOR_ROLE} LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS PASSWORD {sql_literal(password)};
COMMIT;
""")

    def harden(self, before: dict) -> None:
        # psql obtains the application password from the existing postgres
        # container environment. It never enters our command arguments/output.
        self.transport.query(OPERATOR_ROLE, f"""
\\getenv application_password POSTGRES_PASSWORD
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='45s';
SET LOCAL standard_conforming_strings='on';
SELECT pg_advisory_xact_lock({HARDENING_LOCK});
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE usesysid=(SELECT oid FROM pg_roles WHERE rolname='{APP_ROLE}')
 AND pid<>pg_backend_pid() AND {str(bool(before.get('owns_catalogs') or before.get('privileged') or before.get('memberships'))).lower()};
DO $separate_bootstrap$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='{APP_ROLE}' AND n.nspname='pg_catalog') THEN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{BOOTSTRAP_ROLE}') THEN
   RAISE EXCEPTION 'Conflicting bootstrap identity';
  END IF;
  ALTER ROLE {APP_ROLE} RENAME TO {BOOTSTRAP_ROLE};
  ALTER ROLE {BOOTSTRAP_ROLE} NOLOGIN PASSWORD NULL;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{APP_ROLE}') THEN
  CREATE ROLE {APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $separate_bootstrap$;
ALTER ROLE {APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'application_password';
DO $remove_memberships$
DECLARE membership record;
BEGIN
 FOR membership IN SELECT parent.rolname FROM pg_auth_members m
  JOIN pg_roles member ON member.oid=m.member JOIN pg_roles parent ON parent.oid=m.roleid
  WHERE member.rolname='{APP_ROLE}'
 LOOP EXECUTE format('REVOKE %I FROM %I',membership.rolname,'{APP_ROLE}'); END LOOP;
END $remove_memberships$;
ALTER DATABASE {APP_DATABASE} OWNER TO {APP_ROLE};
DO $transfer_project_ownership$
DECLARE object record; object_kind text;
BEGIN
 FOR object IN SELECT n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
  AND (r.rolname IN ('{BOOTSTRAP_ROLE}','{OPERATOR_ROLE}') OR n.nspname='public')
 LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO %I',object.nspname,'{APP_ROLE}'); END LOOP;
 FOR object IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND r.rolname IN ('{BOOTSTRAP_ROLE}','{OPERATOR_ROLE}') AND c.relkind IN ('r','p','S','v','m','f')
  ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END,c.oid
 LOOP
  object_kind:=CASE object.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
   WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END;
  EXECUTE format('ALTER %s %I.%I OWNER TO %I',object_kind,object.nspname,object.relname,'{APP_ROLE}');
 END LOOP;
 FOR object IN SELECT n.nspname,p.proname,p.prokind,pg_get_function_identity_arguments(p.oid) AS arguments
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND r.rolname IN ('{BOOTSTRAP_ROLE}','{OPERATOR_ROLE}') AND p.prokind IN ('f','p','a','w')
 LOOP
  object_kind:=CASE object.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END;
  EXECUTE format('ALTER %s %I.%I(%s) OWNER TO %I',object_kind,object.nspname,object.proname,object.arguments,'{APP_ROLE}');
 END LOOP;
 FOR object IN SELECT n.nspname,t.typname,t.typtype FROM pg_type t
  JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_roles r ON r.oid=t.typowner
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND r.rolname IN ('{BOOTSTRAP_ROLE}','{OPERATOR_ROLE}') AND t.typtype IN ('d','e')
 LOOP
  object_kind:=CASE object.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END;
  EXECUTE format('ALTER %s %I.%I OWNER TO %I',object_kind,object.nspname,object.typname,'{APP_ROLE}');
 END LOOP;
END $transfer_project_ownership$;
COMMIT;
-- A pool may reconnect as the original OID while the rename transaction is
-- still uncommitted. Now NOLOGIN is visible: reap those last old sessions too.
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE usesysid=(SELECT oid FROM pg_roles WHERE rolname='{BOOTSTRAP_ROLE}')
 AND pid<>pg_backend_pid();
""")

    def run(self) -> dict:
        with private_lock(self.shared_dir):
            credentials = operator_credentials(self.shared_dir)
            if self.role_is_admin(OPERATOR_ROLE):
                actor = OPERATOR_ROLE
            elif self.role_is_admin(APP_ROLE):
                actor = APP_ROLE
            elif self.role_is_admin("postgres"):
                # Existing installations may have already created an ordinary
                # cutmy role under the stock postgres bootstrap identity.
                actor = "postgres"
            else:
                raise AccessError("database_admin_identity_unavailable")
            self.configure_operator(actor, credentials["POSTGRES_ADMIN_PASSWORD"])
            before = self.role_state()
            self.harden(before)
            after = self.role_state()
            if (not after.get("exists") or after.get("privileged") or
                    after.get("owns_catalogs") or after.get("memberships")):
                raise AccessError("database_privilege_verification_failed")
            owner = self.transport.query(OPERATOR_ROLE, f"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='{APP_DATABASE}';")
            if owner != APP_ROLE:
                raise AccessError("database_ownership_verification_failed")
            return {"ok": True, "bootstrap_changed": bool(before.get("owns_catalogs")),
                    "restart_required": bool(before.get("owns_catalogs") or before.get("privileged") or before.get("memberships")),
                    "application_role": APP_ROLE, "operator_role": OPERATOR_ROLE}


def main() -> int:
    shared_dir = Path(os.environ.get("CUTMY_SHARED_DIR", "/opt/cutmy/shared"))
    env_file = Path(os.environ.get("CUTMY_ENV_FILE", str(shared_dir / "production.env")))
    deploy_dir = Path(os.environ.get("CUTMY_DEPLOY_DIR", "/opt/cutmy/current/web/deploy"))
    try:
        result = DatabaseAccess(shared_dir, PsqlTransport(env_file, deploy_dir)).run()
    except AccessError as exc:
        print("Database access hardening failed: " + str(exc), file=sys.stderr)
        return 1
    except (OSError, UnicodeError, ValueError):
        print("Database access hardening failed: operator_credentials_unavailable", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
