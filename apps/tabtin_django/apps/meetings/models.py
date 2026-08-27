import uuid

from django.conf import settings
from django.db import models


class MeetingSession(models.Model):
    class LifecycleStatus(models.TextChoices):
        DRAFT = "draft", "草稿"
        PREPARING = "preparing", "准备中"
        RECORDING = "recording", "记录中"
        STOPPED = "stopped", "已停止"
        CANCELLED = "cancelled", "已取消"
        INTERRUPTED = "interrupted", "异常中断"

    class AudioSyncPolicy(models.TextChoices):
        LOCAL_ONLY = "local_only", "仅本地"
        SYNC_AUDIO = "sync_audio", "同步音频"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        "tabtinspace.Organization",
        on_delete=models.CASCADE,
        related_name="meeting_sessions",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="meeting_sessions",
    )
    project = models.ForeignKey(
        "tabtinspace.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="meeting_sessions",
    )
    project_name_snapshot = models.CharField(max_length=255, blank=True, default="")
    title = models.CharField(max_length=255)
    brief = models.TextField(blank=True, default="")
    lifecycle_status = models.CharField(
        max_length=20,
        choices=LifecycleStatus.choices,
        default=LifecycleStatus.DRAFT,
        db_index=True,
    )
    audio_sync_policy = models.CharField(
        max_length=20,
        choices=AudioSyncPolicy.choices,
        default=AudioSyncPolicy.LOCAL_ONLY,
    )
    copilot_initially_enabled = models.BooleanField(default=False)
    copilot_enabled = models.BooleanField(default=False)
    consent_confirmed_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_ms = models.PositiveBigIntegerField(default=0)
    version = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meeting_session"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["organization", "created_by", "-created_at"],
                name="meet_sess_org_owner_idx",
            ),
            models.Index(
                fields=["project", "-created_at"],
                name="meet_sess_project_idx",
            ),
        ]


class MeetingTrack(models.Model):
    class Source(models.TextChoices):
        LOCAL = "local", "麦克风"
        REMOTE = "remote", "系统音频"

    class CaptureStatus(models.TextChoices):
        PENDING = "pending", "待采集"
        ACTIVE = "active", "采集中"
        COMPLETED = "completed", "完整"
        INTERRUPTED = "interrupted", "已中断"
        FAILED = "failed", "失败"
        MISSING = "missing", "缺失"

    class StorageStatus(models.TextChoices):
        LOCAL_ONLY = "local_only", "仅本地"
        UPLOADING = "uploading", "上传中"
        SYNCED = "synced", "已同步"
        MISSING = "missing", "文件缺失"
        DELETED = "deleted", "已删除"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(
        MeetingSession,
        on_delete=models.CASCADE,
        related_name="tracks",
    )
    source = models.CharField(max_length=16, choices=Source.choices)
    capture_status = models.CharField(
        max_length=20,
        choices=CaptureStatus.choices,
        default=CaptureStatus.PENDING,
        db_index=True,
    )
    storage_status = models.CharField(
        max_length=20,
        choices=StorageStatus.choices,
        default=StorageStatus.LOCAL_ONLY,
        db_index=True,
    )
    local_available = models.BooleanField(default=False)
    device_id = models.CharField(max_length=255, blank=True, default="")
    device_label = models.CharField(max_length=255, blank=True, default="")
    sample_rate = models.PositiveIntegerField(default=0)
    channel_count = models.PositiveSmallIntegerField(default=0)
    codec = models.CharField(max_length=32, blank=True, default="")
    container = models.CharField(max_length=32, blank=True, default="")
    duration_ms = models.PositiveBigIntegerField(default=0)
    file_size = models.PositiveBigIntegerField(default=0)
    content_hash = models.CharField(max_length=64, blank=True, default="", db_index=True)
    file_record = models.ForeignKey(
        "oss.FileRecord",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="meeting_tracks",
    )
    last_checkpoint_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meeting_track"
        constraints = [
            models.UniqueConstraint(
                fields=["session", "source"],
                name="meet_track_session_source_uq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["session", "capture_status"],
                name="meet_track_session_state_idx",
            ),
        ]


class MeetingTranscriptRun(models.Model):
    class Mode(models.TextChoices):
        REALTIME = "realtime", "实时转写"
        POST_PROCESS = "post_process", "会后转写"

    class Status(models.TextChoices):
        PENDING = "pending", "待转写"
        RUNNING = "running", "转写中"
        COMPLETED = "completed", "已完成"
        PARTIAL = "partial", "部分完成"
        FAILED = "failed", "失败"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(
        MeetingSession,
        on_delete=models.CASCADE,
        related_name="transcript_runs",
    )
    track = models.ForeignKey(
        MeetingTrack,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="transcript_runs",
    )
    mode = models.CharField(max_length=20, choices=Mode.choices)
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    provider = models.CharField(max_length=64, blank=True, default="")
    model = models.CharField(max_length=128, blank=True, default="")
    language = models.CharField(max_length=32, blank=True, default="")
    metadata = models.JSONField(default=dict, blank=True)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.TextField(blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meeting_transcript_run"
        ordering = ["created_at"]
        indexes = [
            models.Index(
                fields=["session", "mode", "status"],
                name="meet_trun_session_mode_idx",
            ),
        ]


class MeetingTranscriptSegment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(
        MeetingSession,
        on_delete=models.CASCADE,
        related_name="transcript_segments",
    )
    run = models.ForeignKey(
        MeetingTranscriptRun,
        on_delete=models.CASCADE,
        related_name="segments",
    )
    track = models.ForeignKey(
        MeetingTrack,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="transcript_segments",
    )
    external_id = models.CharField(max_length=128)
    source = models.CharField(max_length=16, choices=MeetingTrack.Source.choices)
    speaker_key = models.CharField(max_length=128, blank=True, default="")
    start_ms = models.PositiveBigIntegerField()
    end_ms = models.PositiveBigIntegerField()
    raw_text = models.TextField(blank=True, default="")
    edited_text = models.TextField(blank=True, default="")
    is_final = models.BooleanField(default=False, db_index=True)
    confidence = models.FloatField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    edited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="edited_meeting_transcript_segments",
    )
    edited_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meeting_transcript_segment"
        ordering = ["start_ms", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["run", "external_id"],
                name="meet_tseg_run_external_uq",
            ),
            models.CheckConstraint(
                check=models.Q(end_ms__gte=models.F("start_ms")),
                name="meet_tseg_time_order_ck",
            ),
        ]
        indexes = [
            models.Index(
                fields=["session", "start_ms"],
                name="meet_tseg_session_time_idx",
            ),
            models.Index(
                fields=["session", "source", "is_final"],
                name="meet_tseg_source_final_idx",
            ),
        ]

    @property
    def display_text(self) -> str:
        return self.edited_text or self.raw_text
