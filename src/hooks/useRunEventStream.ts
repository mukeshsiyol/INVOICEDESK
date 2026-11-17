import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEMO_ROLE_STORAGE_KEY } from '../lib/api';

export interface LiveStageEvent {
  id: number;
  run_id: string;
  stage_number: number;
  stage_code: string;
  status: 'STARTED' | 'COMPLETED' | 'WARNING' | 'FAILED';
  summary: string;
  duration_ms: number | null;
  evidence: Record<string, unknown>;
  timestamp: string;
}

export function useRunEventStream(params: {
  runId: string | null | undefined;
  invoiceId: string;
  isActive: boolean;
}) {
  const queryClient = useQueryClient();
  const [liveEvents, setLiveEvents] = useState<LiveStageEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed'>('idle');

  useEffect(() => {
    setLiveEvents([]);
    if (!params.runId || !params.isActive) {
      setStreamStatus('idle');
      return;
    }

    let closedByTerminal = false;
    setStreamStatus('connecting');

    const storedRole =
      typeof window !== 'undefined' ? window.localStorage.getItem(DEMO_ROLE_STORAGE_KEY) : null;
    const roleQuery =
      storedRole === 'OPERATOR' || storedRole === 'REVIEWER' || storedRole === 'ADMIN'
        ? `?demo_role=${storedRole}`
        : '';

    const es = new EventSource(`/api/v1/runs/${params.runId}/events${roleQuery}`, {
      withCredentials: true,
    });

    const handleStage = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data) as LiveStageEvent;
        setStreamStatus('live');
        setLiveEvents((prev) => {
          const exists = prev.some((p) => p.id === parsed.id);
          if (exists) return prev;
          return [...prev, parsed];
        });
      } catch {
        // ignore malformed frame
      }
    };

    const handleTerminal = () => {
      closedByTerminal = true;
      setStreamStatus('closed');
      es.close();
      void queryClient.invalidateQueries({ queryKey: ['invoice', params.invoiceId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };

    es.onopen = () => setStreamStatus('live');
    es.addEventListener('stage_started', handleStage);
    es.addEventListener('stage_completed', handleStage);
    es.addEventListener('stage_failed', handleStage);
    es.addEventListener('run_completed', handleTerminal);
    es.addEventListener('run_failed', handleTerminal);

    es.onerror = () => {
      if (!closedByTerminal) {
        setStreamStatus('reconnecting');
      }
    };

    return () => {
      closedByTerminal = true;
      es.close();
    };
  }, [params.runId, params.invoiceId, params.isActive, queryClient]);

  return { liveEvents, streamStatus };
}
