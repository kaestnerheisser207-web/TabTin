import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def backfill_transcript_revisions(apps, schema_editor):
    MeetingSession = apps.get_model("meetings", "MeetingSession")
    MeetingTranscriptSegment = apps.get_model("meetings", "MeetingTranscriptSegment")
    counts = (
        MeetingTranscriptSegment.objects.values("session_id")
        .annotate(total=models.Count("id"))
        .iterator()
    )
    for row in counts:
        MeetingSession.objects.filter(id=row["session_id"]).update(
            transcript_revision=row["total"],
        )


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("meetings", "0003_meeting_permissions_and_cloud_audio"),
    ]

    operations = [
        migrations.AddField(
            model_name="meetingsession",
            name="transcript_revision",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.RunPython(
            backfill_transcript_revisions,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.CreateModel(
            name="MeetingAnalysis",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "待分析"),
                            ("running", "分析中"),
                            ("completed", "已完成"),
                            ("partial", "部分完成"),
                            ("failed", "失败"),
                        ],
                        db_index=True,
                        default="pending",
                        max_length=20,
                    ),
                ),
                ("summary", models.TextField(blank=True, default="")),
                ("topics", models.JSONField(blank=True, default=list)),
                ("decisions", models.JSONField(blank=True, default=list)),
                ("action_items", models.JSONField(blank=True, default=list)),
                ("open_questions", models.JSONField(blank=True, default=list)),
                ("risks", models.JSONField(blank=True, default=list)),
                ("source_transcript_revision", models.PositiveIntegerField(default=0)),
                ("provider", models.CharField(blank=True, default="", max_length=64)),
                ("model", models.CharField(blank=True, default="", max_length=128)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("error_message", models.TextField(blank=True, default="")),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "requested_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="requested_meeting_analyses",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "session",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="analysis",
                        to="meetings.meetingsession",
                    ),
                ),
            ],
            options={
                "db_table": "meeting_analysis",
                "indexes": [
                    models.Index(
                        fields=["status", "updated_at"],
                        name="meet_analysis_status_idx",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="MeetingReference",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "reference_type",
                    models.CharField(
                        choices=[("document", "文档"), ("task", "任务")],
                        max_length=20,
                    ),
                ),
                ("resource_id", models.UUIDField()),
                ("title_snapshot", models.CharField(blank=True, default="", max_length=255)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_meeting_references",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="references",
                        to="meetings.meetingsession",
                    ),
                ),
            ],
            options={
                "db_table": "meeting_reference",
                "ordering": ["created_at", "id"],
                "indexes": [
                    models.Index(
                        fields=["reference_type", "resource_id"],
                        name="meet_ref_type_resource_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("session", "reference_type", "resource_id"),
                        name="meet_ref_session_type_resource_uq",
                    ),
                ],
            },
        ),
    ]
