from django.test import SimpleTestCase

from .api import is_lifecycle_transition_allowed
from .models import MeetingSession, MeetingTrack, MeetingTranscriptSegment


class MeetingLifecycleTests(SimpleTestCase):
    def test_recording_can_only_end_or_be_interrupted(self):
        self.assertTrue(is_lifecycle_transition_allowed("recording", "stopped"))
        self.assertTrue(is_lifecycle_transition_allowed("recording", "interrupted"))
        self.assertFalse(is_lifecycle_transition_allowed("recording", "paused"))
        self.assertFalse(is_lifecycle_transition_allowed("paused", "recording"))
        self.assertFalse(is_lifecycle_transition_allowed("interrupted", "recording"))

    def test_terminal_states_cannot_restart(self):
        self.assertFalse(is_lifecycle_transition_allowed("stopped", "recording"))
        self.assertFalse(is_lifecycle_transition_allowed("cancelled", "preparing"))

    def test_same_transition_is_idempotent(self):
        self.assertTrue(is_lifecycle_transition_allowed("recording", "recording"))


class MeetingModelContractTests(SimpleTestCase):
    def test_session_has_independent_lifecycle_and_copilot_state(self):
        field_names = {field.name for field in MeetingSession._meta.fields}
        self.assertIn("lifecycle_status", field_names)
        self.assertIn("copilot_initially_enabled", field_names)
        self.assertIn("copilot_enabled", field_names)

    def test_tracks_keep_local_and_remote_sources_separate(self):
        self.assertEqual(set(MeetingTrack.Source.values), {"local", "remote"})
        constraint_names = {item.name for item in MeetingTrack._meta.constraints}
        self.assertIn("meet_track_session_source_uq", constraint_names)

    def test_transcript_preserves_raw_and_edited_text(self):
        segment = MeetingTranscriptSegment(raw_text="raw", edited_text="edited")
        self.assertEqual(segment.display_text, "edited")
        segment.edited_text = ""
        self.assertEqual(segment.display_text, "raw")
