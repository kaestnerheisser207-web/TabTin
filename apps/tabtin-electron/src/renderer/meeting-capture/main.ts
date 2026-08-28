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
    reportCaptureSourceEnded: (event) => {
      void window.tabtin.meetingRecording
        .reportCaptureSourceEnded(event)
        .catch(() => undefined);
    },
    reportCaptureDevicesChanged: (event) => {
      void window.tabtin.meetingRecording
        .reportCaptureDevicesChanged(event)
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
    prepareMicrophoneSwitch:
      controller.prepareMicrophoneSwitch.bind(controller),
    prepareSystemAudioSwitch:
      controller.prepareSystemAudioSwitch.bind(controller),
    commitSourceSwitch: controller.commitSourceSwitch.bind(controller),
    abortSourceSwitch: controller.abortSourceSwitch.bind(controller),
    finalizeSourceSwitch: controller.finalizeSourceSwitch.bind(controller),
    rollbackSourceSwitch: controller.rollbackSourceSwitch.bind(controller),
    start: controller.start.bind(controller),
    stop: controller.stop.bind(controller),
    getState: controller.getState.bind(controller),
  },
});
