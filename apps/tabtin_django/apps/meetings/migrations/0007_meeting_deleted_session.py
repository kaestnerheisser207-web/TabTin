from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("meetings", "0006_meeting_copilot_clarification_status")]

    operations = [
        migrations.CreateModel(
            name="MeetingDeletedSession",
            fields=[
                ("session_id", models.UUIDField(primary_key=True, serialize=False)),
                ("organization_id", models.UUIDField()),
                ("created_by_id", models.UUIDField()),
                ("deleted_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "meeting_deleted_session"},
        ),
    ]
