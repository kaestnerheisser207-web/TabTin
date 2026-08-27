import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("meetings", "0002_remove_meeting_pause"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="meetingsession",
            name="audio_sync_policy",
        ),
        migrations.CreateModel(
            name="MeetingPermission",
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
                    "subject_type",
                    models.CharField(
                        choices=[
                            ("user", "User"),
                            ("role", "Role"),
                            ("agent", "Agent"),
                        ],
                        max_length=20,
                        verbose_name="权限主体类型",
                    ),
                ),
                (
                    "subject_id",
                    models.CharField(max_length=64, verbose_name="权限主体 ID"),
                ),
                (
                    "permission",
                    models.CharField(
                        choices=[
                            ("viewer", "Viewer"),
                            ("editor", "Editor"),
                            ("admin", "Admin"),
                            ("owner", "Owner"),
                        ],
                        default="viewer",
                        max_length=20,
                        verbose_name="权限级别",
                    ),
                ),
                ("is_active", models.BooleanField(default=True, verbose_name="是否生效")),
                (
                    "granted_by",
                    models.CharField(
                        blank=True,
                        default="",
                        max_length=64,
                        verbose_name="授权人 ID",
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="permissions",
                        to="meetings.meetingsession",
                    ),
                ),
            ],
            options={
                "db_table": "meeting_permission",
                "indexes": [
                    models.Index(
                        fields=["session", "is_active"],
                        name="meet_perm_session_active_idx",
                    ),
                    models.Index(
                        fields=["subject_type", "subject_id"],
                        name="meet_perm_subject_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("session", "subject_type", "subject_id"),
                        name="meet_perm_session_subject_uq",
                    ),
                ],
            },
        ),
    ]
