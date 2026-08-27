const listeners = new Set<() => void>();

export function notifyStudyScheduleChanged(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeStudyScheduleChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
