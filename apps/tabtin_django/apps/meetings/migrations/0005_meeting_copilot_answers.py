import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("meetings", "0004_meeting_analysis_and_references"),
    ]

    operations = [
        migrations.CreateModel(
            name="MeetingCopilotAnswer",
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
                ("request_id", models.UUIDField()),
                ("question_segment_id", models.CharField(max_length=128)),
                ("question_text", models.TextField(blank=True, default="")),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "生成中"),
                            ("answered", "已回答"),
                            ("no_action", "无需回答"),
                        ],
                        max_length=20,
                    ),
                ),
                ("result_snapshot", models.JSONField(default=dict)),
                ("model", models.CharField(blank=True, default="", max_length=128)),
                ("provider", models.CharField(blank=True, default="", max_length=64)),
                ("latency_ms", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="copilot_answers",
                        to="meetings.meetingsession",
                    ),
                ),
            ],
            options={
                "db_table": "meeting_copilot_answer",
                "ordering": ["created_at", "id"],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("session", "request_id"),
                        name="meet_copilot_session_request_uq",
                    ),
                ],
                "indexes": [
                    models.Index(
                        fields=["session", "created_at"],
                        name="meet_copilot_session_time_idx",
                    ),
                ],
            },
        ),
    ]
