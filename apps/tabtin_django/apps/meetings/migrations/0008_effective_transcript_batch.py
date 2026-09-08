from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("meetings", "0007_meeting_deleted_session")]
    operations = [
        migrations.AddField(
            model_name="meetingsession",
            name="effective_transcript_batch_id",
            field=models.UUIDField(null=True, blank=True),
        ),
    ]
