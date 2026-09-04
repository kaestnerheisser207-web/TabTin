"""Isolated PostgreSQL settings for the meeting-record domain tests.

The base settings intentionally reload .env.local with override=True. These
settings therefore use MEETINGS_TEST_PG_* variables, which are not present in
the developer env file, to guarantee that tests cannot silently target the
configured remote database.
"""

from __future__ import annotations

import os

from .settings import *  # noqa: F401,F403

MUSE_DATABASE_MODE = "single_pg"
MUSE_SINGLE_DATABASE_MODE = True


def _meeting_test_pg_config(name: str) -> dict:
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": os.environ["MEETINGS_TEST_PG_USER"],
        "PASSWORD": os.environ["MEETINGS_TEST_PG_PASSWORD"],
        "HOST": os.environ.get("MEETINGS_TEST_PG_HOST", "127.0.0.1"),
        "PORT": os.environ.get("MEETINGS_TEST_PG_PORT", "55432"),
        "OPTIONS": {"options": "-c search_path=public", "sslmode": "disable"},
    }


_database_name = os.environ.get(
    "MEETINGS_TEST_PG_NAME",
    "tabtin_meetings_test",
)
_test_database_name = os.environ.get(
    "MEETINGS_TEST_PG_TEST_NAME",
    "test_tabtin_meetings",
)
DATABASES["default"] = _meeting_test_pg_config(_database_name)  # type: ignore[name-defined]
DATABASES["default"]["TEST"] = {"NAME": _test_database_name}  # type: ignore[name-defined]
DATABASES["postgresql"] = {  # type: ignore[name-defined]
    **_meeting_test_pg_config(_database_name),
    "TEST": {"MIRROR": "default"},
}
DATABASE_ROUTERS = []  # type: ignore[name-defined]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.postgres",
    "ninja",
    "apps.users.auth",
    "apps.users.membership",
    "apps.users.wallet",
    "apps.agent.apps.AgentConfig",
    "apps.meetings.test_app_configs.ConversationMeetingTestConfig",
    "apps.services.llm",
    "apps.meetings.test_app_configs.TabtinspaceMeetingTestConfig",
    "apps.services.oss",
    "apps.services.notification",
    "apps.services.billing",
    "apps.tabdoc",
    "apps.tabdata",
    "apps.meetings.apps.MeetingsConfig",
]

ROOT_URLCONF = "tabtin.tests_urls_empty"
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()
