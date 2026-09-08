"""Schema-only release compatibility for migrations already applied on sg01."""
from types import SimpleNamespace
from django.apps import apps
from django.db.migrations.autodetector import MigrationAutodetector
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.state import ProjectState
from django.test import SimpleTestCase
from apps.meetings.models import MeetingSession, MeetingDeletedSession
from apps.services.migration_guard.tests import test_check_migration_integrity as integrity_fixtures

class MeetingSchemaCompatibilityTests(SimpleTestCase):
    def test_applied_migrations_are_in_release_graph_and_models_match(self):
        loader=MigrationLoader(None,ignore_no_migrations=True)
        for name in ['0007_meeting_deleted_session','0008_effective_transcript_batch']:
            self.assertIn(('meetings',name),loader.disk_migrations)
        changes=MigrationAutodetector(loader.project_state(),ProjectState.from_apps(apps)).changes(
            graph=loader.graph,trim_to_apps={'meetings'},
        )
        self.assertNotIn('meetings',changes)

    def test_passive_models_match_additive_schema(self):
        self.assertTrue(MeetingSession._meta.get_field('effective_transcript_batch_id').null)
        self.assertEqual(MeetingDeletedSession._meta.db_table,'meeting_deleted_session')
        self.assertEqual(MeetingDeletedSession._meta.pk.name,'session_id')
        self.assertEqual({f.name for f in MeetingDeletedSession._meta.local_fields},
                         {'session_id','organization_id','created_by_id','deleted_at'})

    def test_published_applied_meeting_history_passes_artifact_guard(self):
        keys={('meetings','0007_meeting_deleted_session'),('meetings','0008_effective_transcript_batch')}
        rows=[(index,'meetings',name) for index,(_app,name) in enumerate(sorted(keys),1)]
        output,_=integrity_fixtures.CheckMigrationIntegrityTests()._run(
            default_rows=rows,pg_rows=rows,disk_migrations=keys,
            installed_apps={'meetings'},argv=['--artifact-preflight'],
        )
        self.assertNotIn('发布包外 migration',output)

    def test_nullable_extra_column_does_not_break_old_model_insert_guard(self):
        rows=[(1,'meetings','0006_meeting_copilot_clarification_status')]
        old_model=integrity_fixtures._make_model('meetings','meetingsession','meeting_session',['id'])
        columns=['id',SimpleNamespace(name='effective_transcript_batch_id',null_ok=True,default=None)]
        output,_=integrity_fixtures.CheckMigrationIntegrityTests()._run(
            default_rows=rows,pg_rows=rows,disk_migrations={('meetings',rows[0][2])},
            installed_apps={'meetings'},argv=['--schema','--strict'],models=[old_model],
            default_tables={'meeting_session':columns},pg_tables={'meeting_session':columns},
        )
        self.assertNotIn('NOT NULL 无默认字段',output)
