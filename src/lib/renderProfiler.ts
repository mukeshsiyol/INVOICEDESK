import type { ProfilerOnRenderCallback } from 'react';

export interface RenderTimingSample {
  id: string;
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  recordedAt: string;
}

export interface ProfilerSummary {
  id: string;
  renders: number;
  mounts: number;
  updates: number;
  slowRenders: number;
  maxActualDuration: number;
  avgActualDuration: number;
  lastActualDuration: number;
  lastBaseDuration: number;
  lastPhase: 'mount' | 'update' | 'nested-update';
}

const SLOW_RENDER_THRESHOLD_MS = 16;
const MAX_SAMPLES = 200;

const samples: RenderTimingSample[] = [];
const statsById = new Map<
  string,
  {
    renders: number;
    mounts: number;
    updates: number;
    slowRenders: number;
    totalActualDuration: number;
    maxActualDuration: number;
    lastActualDuration: number;
    lastBaseDuration: number;
    lastPhase: 'mount' | 'update' | 'nested-update';
  }
>();

export function getProfilerSummary(): ProfilerSummary[] {
  return Array.from(statsById.entries()).map(([id, stat]) => ({
    id,
    renders: stat.renders,
    mounts: stat.mounts,
    updates: stat.updates,
    slowRenders: stat.slowRenders,
    maxActualDuration: Number(stat.maxActualDuration.toFixed(2)),
    avgActualDuration: Number((stat.totalActualDuration / Math.max(1, stat.renders)).toFixed(2)),
    lastActualDuration: Number(stat.lastActualDuration.toFixed(2)),
    lastBaseDuration: Number(stat.lastBaseDuration.toFixed(2)),
    lastPhase: stat.lastPhase,
  }));
}

export function getProfilerSamples(): RenderTimingSample[] {
  return [...samples];
}

export function clearProfilerStats(): void {
  samples.length = 0;
  statsById.clear();
}

declare global {
  interface Window {
    __INVOICEDESK_PROFILER__?: {
      getSummary: () => ProfilerSummary[];
      getSamples: () => RenderTimingSample[];
      clear: () => void;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__INVOICEDESK_PROFILER__ = {
    getSummary: getProfilerSummary,
    getSamples: getProfilerSamples,
    clear: clearProfilerStats,
  };
}

export const handleProfilerRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime
) => {
  const roundedActual = Number(actualDuration.toFixed(2));
  const roundedBase = Number(baseDuration.toFixed(2));

  const prev = statsById.get(id) ?? {
    renders: 0,
    mounts: 0,
    updates: 0,
    slowRenders: 0,
    totalActualDuration: 0,
    maxActualDuration: 0,
    lastActualDuration: 0,
    lastBaseDuration: 0,
    lastPhase: phase,
  };

  prev.renders += 1;
  if (phase === 'mount') {
    prev.mounts += 1;
  } else {
    prev.updates += 1;
  }
  if (actualDuration >= SLOW_RENDER_THRESHOLD_MS) {
    prev.slowRenders += 1;
  }
  prev.totalActualDuration += actualDuration;
  prev.maxActualDuration = Math.max(prev.maxActualDuration, actualDuration);
  prev.lastActualDuration = actualDuration;
  prev.lastBaseDuration = baseDuration;
  prev.lastPhase = phase;
  statsById.set(id, prev);

  samples.push({
    id,
    phase,
    actualDuration: roundedActual,
    baseDuration: roundedBase,
    startTime: Number(startTime.toFixed(2)),
    commitTime: Number(commitTime.toFixed(2)),
    recordedAt: new Date().toISOString(),
  });
  if (samples.length > MAX_SAMPLES) {
    samples.shift();
  }

  if (import.meta.env.DEV) {
    if (actualDuration >= SLOW_RENDER_THRESHOLD_MS) {
      console.warn(
        `[Profiler:${id}] slow ${phase} (${roundedActual}ms actual / ${roundedBase}ms base, renders=${prev.renders})`
      );
    } else {
      console.debug(
        `[Profiler:${id}] ${phase} ${roundedActual}ms (base ${roundedBase}ms, renders=${prev.renders})`
      );
    }
  }
};
