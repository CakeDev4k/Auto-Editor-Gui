const VIDEO_EXT_LIST = [
  "mp4",
  "mov",
  "mkv",
  "avi",
  "flv",
  "wmv",
  "webm",
  "m4v",
];

export const VIDEO_EXTS = new Set(VIDEO_EXT_LIST);
export const SUPPORTED_EXTS = [
  ...VIDEO_EXT_LIST,
  "wav",
  "mp3",
  "m4a",
];
