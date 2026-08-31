from django.db import migrations


def remove_legacy_cloud_git_credentials(apps, schema_editor):
    Allocation = apps.get_model("tabtinspace", "CloudRuntimeAllocation")
    SecureCredential = apps.get_model("tabtinspace", "SecureCredential")
    db = schema_editor.connection.alias

    referenced_ids = set()
    for allocation in Allocation.objects.using(db).exclude(git_credential_ref=""):
        referenced_ids.add(allocation.git_credential_ref)
        allocation.state = "error"
        allocation.next_retry_at = None
        allocation.last_error = "github_connection_required"
        allocation.git_credential_ref = ""
        allocation.save(
            using=db,
            update_fields=[
                "state",
                "next_retry_at",
                "last_error",
                "git_credential_ref",
                "updated_at",
            ],
        )

    for credential in SecureCredential.objects.using(db).filter(id__in=referenced_ids):
        metadata = credential.metadata or {}
        if (
            metadata.get("purpose") == "cloud_git"
            and metadata.get("provider") == "github"
        ):
            credential.delete(using=db)


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0146_cloud_runtime_models"),
    ]

    operations = [
        migrations.RunPython(
            remove_legacy_cloud_git_credentials,
            migrations.RunPython.noop,
        ),
        migrations.RemoveField(
            model_name="cloudruntimeallocation",
            name="git_credential_ref",
        ),
    ]
