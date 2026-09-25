/** Media time formatting (pure, unit-tested). */

/** 83.4 → "1:23"; an hour or more → "1:02:03". */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

/** Millisecond precision for the audio transport: 83.4567 → "1:23.457". */
export function formatPrecise(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000';
  const millis = Math.round(seconds * 1000);
  const minutes = Math.floor(millis / 60000);
  const secs = Math.floor((millis % 60000) / 1000);
  const ms = millis % 1000;
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
