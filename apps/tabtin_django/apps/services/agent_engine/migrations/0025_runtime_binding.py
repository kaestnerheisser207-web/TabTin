import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('agent_engine', '0024_session_read_receipts'),
        ('tabtinspace', '0146_cloud_runtime_models'),
    ]

    operations = [
        migrations.CreateModel(
            name='RuntimeBinding',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('thread_id', models.CharField(max_length=128)),
                ('harness', models.CharField(choices=[('builtin', 'Builtin'), ('dsh', 'DSH')], max_length=16)),
                ('driver_session_ref', models.JSONField(blank=True, default=dict)),
                ('state', models.CharField(choices=[('active', 'Active'), ('suspended', 'Suspended'), ('closed', 'Closed'), ('error', 'Error')], db_index=True, default='active', max_length=16)),
                ('host_generation', models.PositiveBigIntegerField(default=1)),
                ('revision', models.PositiveBigIntegerField(default=1)),
                ('last_error', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('allocation', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='runtime_bindings', to='tabtinspace.cloudruntimeallocation')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='tabtinspace.organization')),
                ('workspace', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='runtime_bindings', to='tabtinspace.workspace')),
            ],
            options={
                'db_table': 'agent_engine_runtime_bindings',
            },
        ),
        migrations.AddConstraint(
            model_name='runtimebinding',
            constraint=models.UniqueConstraint(fields=('organization', 'workspace', 'thread_id', 'harness'), name='uq_runtime_binding_identity'),
        ),
        migrations.AddIndex(
            model_name='runtimebinding',
            index=models.Index(fields=['allocation', 'state'], name='idx_runtime_binding_alloc'),
        ),
        migrations.AddIndex(
            model_name='runtimebinding',
            index=models.Index(fields=['organization', 'state'], name='idx_runtime_binding_org'),
        ),
    ]
