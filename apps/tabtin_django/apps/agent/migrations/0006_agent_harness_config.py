"""Move Agent execution choice to ``agent_config.harness``.

Runtime plane belongs to Workspace Device. Existing Agents are rewritten once
to the builtin Harness; the retired Agent-level ``runtime_plane`` and
``agent_backend`` keys are removed instead of retained through compatibility
readers.
"""

from django.db import migrations


def rewrite_agent_harness(apps, schema_editor):
    Agent = apps.get_model("agent", "Agent")
    db_alias = schema_editor.connection.alias
    to_update = []
    for agent in Agent.objects.using(db_alias).only("id", "agent_config").iterator():
        config = dict(agent.agent_config or {})
        config.pop("runtime_plane", None)
        config.pop("agent_backend", None)
        config["harness"] = {"type": "builtin"}
        agent.agent_config = config
        to_update.append(agent)
    if to_update:
        Agent.objects.using(db_alias).bulk_update(
            to_update,
            ["agent_config"],
            batch_size=500,
        )


class Migration(migrations.Migration):
    dependencies = [
        ("agent", "0005_rename_default_agent_to_xiaotin"),
    ]

    operations = [
        migrations.RunPython(rewrite_agent_harness, migrations.RunPython.noop),
    ]
