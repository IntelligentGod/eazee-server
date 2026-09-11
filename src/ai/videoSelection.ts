export function excludeVideosById<T extends { videoId: string }>(videos: T[], excludeVideoIds: string[]) {
  if (!excludeVideoIds.length) return videos;

  const excludedVideoIds = new Set(excludeVideoIds);
  return videos.filter((video) => !excludedVideoIds.has(video.videoId));
}
