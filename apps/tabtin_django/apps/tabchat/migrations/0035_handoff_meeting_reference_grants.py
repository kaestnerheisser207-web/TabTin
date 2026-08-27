import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("tabchat", "0034_alter_conversationagentworkspace_bound_at"),
    ]

    operations = [
        migrations.AlterField(
            model_name="handoffreference",
            name="ref_type",
            field=models.CharField(
                choices=[
                    ("im_message", "IM 消息"),
                    ("document", "文档"),
                    ("table", "表格"),
                    ("attachment", "附件"),
                    ("chat_session", "Agent 会话"),
                    ("meeting", "会议档案"),
                ],
                max_length=20,
            ),
        ),
        migrations.AlterField(
            model_name="handoffevent",
            name="event_type",
            field=models.CharField(
                choices=[
                    ("created", "创建"),
                    ("sent", "发送"),
                    ("viewed", "查看"),
                    ("acknowledged", "已了解"),
                    ("taken_over", "由我继续"),
                    ("delegated", "交给 Agent"),
                    ("supplemented", "补充"),
                    ("superseded", "已被新版本取代"),
                    ("revoked", "撤销"),
                    ("rejected", "拒绝"),
                ],
                max_length=20,
            ),
        ),
        migrations.CreateModel(
            name="HandoffResourceGrant",
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
                    "resource_type",
                    models.CharField(
                        choices=[("meeting", "会议档案")],
                        max_length=20,
                    ),
                ),
                ("resource_id", models.UUIDField()),
                ("grantee_user_id", models.CharField(db_index=True, max_length=100)),
                ("permission_id", models.UUIDField(blank=True, null=True)),
                (
                    "permission_updated_at_snapshot",
                    models.DateTimeField(blank=True, null=True),
                ),
                (
                    "permission_granted_by_snapshot",
                    models.CharField(blank=True, default="", max_length=100),
                ),
                ("is_active", models.BooleanField(db_index=True, default=True)),
                (
                    "manages_resource_permission",
                    models.BooleanField(
                        default=False,
                        help_text="该来源需要维持资源 ACL；最后一个有效来源撤销时才能回收。",
                    ),
                ),
                (
                    "has_independent_access",
                    models.BooleanField(
                        default=False,
                        help_text="发送交接前用户已通过非 Handoff 来源拥有访问权。",
                    ),
                ),
                (
                    "independent_permission",
                    models.CharField(blank=True, default="", max_length=20),
                ),
                ("created_permission", models.BooleanField(default=False)),
                ("previous_is_active", models.BooleanField(blank=True, null=True)),
                (
                    "previous_permission",
                    models.CharField(blank=True, default="", max_length=20),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                (
                    "package",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="resource_grants",
                        to="tabchat.handoffpackage",
                    ),
                ),
                (
                    "reference",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="resource_grants",
                        to="tabchat.handoffreference",
                    ),
                ),
            ],
            options={
                "db_table": "tabchat_handoff_resource_grant",
                "indexes": [
                    models.Index(
                        fields=[
                            "resource_type",
                            "resource_id",
                            "grantee_user_id",
                            "is_active",
                        ],
                        name="tabchat_handoff_grant_acl_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("package", "reference", "grantee_user_id"),
                        name="tabchat_handoff_grant_source_uq",
                    ),
                ],
            },
        ),
    ]
