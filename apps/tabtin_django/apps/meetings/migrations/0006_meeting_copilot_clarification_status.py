from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("meetings", "0005_meeting_copilot_answers"),
    ]

    operations = [
        migrations.AlterField(
            model_name="meetingcopilotanswer",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "生成中"),
                    ("answered", "已回答"),
                    ("no_action", "无需回答"),
                    ("needs_clarification", "需要澄清"),
                ],
                max_length=20,
            ),
        ),
    ]
