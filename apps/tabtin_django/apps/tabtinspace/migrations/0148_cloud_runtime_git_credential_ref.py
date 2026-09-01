from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0147_remove_legacy_cloud_git_credential"),
    ]

    operations = [
        migrations.AddField(
            model_name="cloudruntimeallocation",
            name="git_credential_ref",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
    ]
