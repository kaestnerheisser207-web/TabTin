import { MeetingCaptureController } from './MeetingCaptureController';

const controller = new MeetingCaptureController({
  sink: {
    appendAudioChunk: (input) =>
      window.tabtin.meetingRecording.appendAudioChunk(input),
    appendPcmChunk: (input) =>
      window.tabtin.meetingRecording.appendPcmChunk(input),
    reportCaptureLevel: (event) => {
      void window.tabtin.meetingRecording
        .reportCaptureLevel(event)
        .catch(() => undefined);
    },
    reportMicrophoneTestLevel: (event) => {
      void window.tabtin.meetingRecording
        .reportMicrophoneTestLevel(event)
        .catch(() => undefined);
    },
  },
});

Object.assign(globalThis, {
  __TABTIN_MEETING_CAPTURE__: {
    probe: controller.probe.bind(controller),
    listMicrophones: controller.listMicrophones.bind(controller),
    listSystemAudioSources: controller.listSystemAudioSources.bind(controller),
    testMicrophone: controller.testMicrophone.bind(controller),
    switchMicrophone: controller.switchMicrophone.bind(controller),
    switchSystemAudio: controller.switchSystemAudio.bind(controller),
    start: controller.start.bind(controller),
    pause: controller.pause.bind(controller),
    resume: controller.resume.bind(controller),
    stop: controller.stop.bind(controller),
    getState: controller.getState.bind(controller),
  },
});
