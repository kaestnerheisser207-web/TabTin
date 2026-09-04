from django.apps import AppConfig


class TabtinspaceMeetingTestConfig(AppConfig):
    """Load real tabtinspace models without cross-product signal side effects."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.tabtinspace"
    label = "tabtinspace"
    verbose_name = "Muse Space (meeting tests)"


class ConversationMeetingTestConfig(AppConfig):
    """Load conversation models without registering unrelated signal handlers."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.chat.conversation"
    label = "conversation"
    verbose_name = "Conversation (meeting tests)"
