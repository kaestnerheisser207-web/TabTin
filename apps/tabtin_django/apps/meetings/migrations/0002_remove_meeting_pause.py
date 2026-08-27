from django.db import migrations, models


def mark_paused_records_interrupted(apps, schema_editor):
    MeetingSession = apps.get_model("meetings", "MeetingSession")
    MeetingTrack = apps.get_model("meetings", "MeetingTrack")
    MeetingSession.objects.filter(lifecycle_status="paused").update(
        lifecycle_status="interrupted"
    )
    MeetingTrack.objects.filter(capture_status="paused").update(
        capture_status="interrupted"
    )


class Migration(migrations.Migration):
    dependencies = [
        ("meetings", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(
            mark_paused_records_interrupted,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.AlterField(
            model_name="meetingsession",
            name="lifecycle_status",
            field=models.CharField(
                choices=[
                    ("draft", "草稿"),
                    ("preparing", "准备中"),
                    ("recording", "记录中"),
                    ("stopped", "已停止"),
                    ("cancelled", "已取消"),
                    ("interrupted", "异常中断"),
                ],
                db_index=True,
                default="draft",
                max_length=20,
            ),
        ),
        migrations.AlterField(
            model_name="meetingtrack",
            name="capture_status",
            field=models.CharField(
                choices=[
                    ("pending", "待采集"),
                    ("active", "采集中"),
                    ("completed", "完整"),
                    ("interrupted", "已中断"),
                    ("failed", "失败"),
                    ("missing", "缺失"),
                ],
                db_index=True,
                default="pending",
                max_length=20,
            ),
        ),
    ]
