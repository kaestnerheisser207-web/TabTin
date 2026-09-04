/**
 * Speech route handler for Daemon CLI Server.
 *
 * Delegates to `@muse/media-capabilities` `createAudioHandler`:
 * TTS via `synthesizeSpeech` capability (middleware chain); ASR / providers / voices
 * proxied to Django.
 */

import { createAudioHandler } from '@muse/media-capabilities/routes';
import { djangoRequest } from '../shared/error-handler.js';

export const handleSpeechRoute = createAudioHandler({
  djangoRequest,
  logTag: '[CLI Speech]',
});
