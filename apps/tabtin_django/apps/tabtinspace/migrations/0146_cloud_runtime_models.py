import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('tabtinspace', '0145_shared_resource_placement_dismissed'),
    ]

    operations = [
        migrations.CreateModel(
            name='CloudWorkerNode',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('node_key', models.CharField(max_length=128, unique=True)),
                ('name', models.CharField(max_length=200)),
                ('edition', models.CharField(choices=[('saas', 'SaaS 托管'), ('community', 'Community 自托管')], default='saas', max_length=16)),
                ('state', models.CharField(choices=[('registering', '注册中'), ('ready', '可调度'), ('draining', '排空中'), ('offline', '离线'), ('error', '异常')], db_index=True, default='registering', max_length=16)),
                ('control_endpoint', models.CharField(help_text='仅服务端可达的 Worker Supervisor 地址。', max_length=500)),
                ('protocol_version', models.CharField(max_length=64)),
                ('runtime_version', models.CharField(max_length=128)),
                ('capacity_cpu_millicores', models.PositiveIntegerField(default=0)),
                ('capacity_memory_mb', models.PositiveIntegerField(default=0)),
                ('capacity_storage_gb', models.PositiveIntegerField(default=0)),
                ('last_heartbeat_at', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('metadata_json', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('organization', models.ForeignKey(blank=True, help_text='Community Worker 的组织边界；SaaS 共享池为空。', null=True, on_delete=django.db.models.deletion.CASCADE, related_name='cloud_worker_nodes', to='tabtinspace.organization')),
            ],
            options={
                'db_table': 'tabtinspace_cloud_worker_node',
            },
        ),
        migrations.CreateModel(
            name='CloudRuntimeAllocation',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('request_key', models.UUIDField(help_text='客户端生成的 Cloud Workspace 创建幂等键。', unique=True)),
                ('state', models.CharField(choices=[('pending', '等待分配'), ('provisioning', '创建中'), ('ready', '可用'), ('disabled', '已停用'), ('error', '异常'), ('deleting', '删除中'), ('deleted', '已删除')], db_index=True, default='pending', max_length=16)),
                ('generation', models.PositiveBigIntegerField(default=1)),
                ('volume_ref', models.CharField(max_length=255, unique=True)),
                ('runtime_image', models.CharField(max_length=500)),
                ('source_type', models.CharField(choices=[('empty', '空目录'), ('git', 'Git 仓库')], default='empty', max_length=16)),
                ('git_url', models.CharField(blank=True, default='', max_length=2000)),
                ('git_ref', models.CharField(blank=True, default='', max_length=255)),
                ('git_credential_ref', models.CharField(blank=True, default='', max_length=255)),
                ('cpu_millicores', models.PositiveIntegerField(default=2000)),
                ('memory_mb', models.PositiveIntegerField(default=4096)),
                ('storage_gb', models.PositiveIntegerField(default=20)),
                ('last_error', models.TextField(blank=True, default='')),
                ('reconcile_attempts', models.PositiveIntegerField(default=0)),
                ('next_retry_at', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('provisioned_at', models.DateTimeField(blank=True, null=True)),
                ('retention_deadline', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('device', models.OneToOneField(help_text='Workspace 绑定的逻辑 cloud Device。', on_delete=django.db.models.deletion.PROTECT, related_name='cloud_allocation', to='tabtinspace.device')),
                ('worker', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='allocations', to='tabtinspace.cloudworkernode')),
                ('workspace', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='cloud_allocation', to='tabtinspace.workspace')),
            ],
            options={
                'db_table': 'tabtinspace_cloud_runtime_allocation',
            },
        ),
        migrations.AddIndex(
            model_name='cloudworkernode',
            index=models.Index(fields=['edition', 'state'], name='ctx_cloud_worker_sched_idx'),
        ),
        migrations.AddIndex(
            model_name='cloudruntimeallocation',
            index=models.Index(fields=['worker', 'state'], name='ctx_cloud_alloc_worker_idx'),
        ),
    ]
