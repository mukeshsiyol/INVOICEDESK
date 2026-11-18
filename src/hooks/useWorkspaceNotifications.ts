import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, getDemoAuthQueryString } from '../lib/api';

export type NotificationEventType =
  | 'INVOICE_UPLOADED'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'PIPELINE_FAILED'
  | 'REVIEW_RESOLVED';

export interface WorkspaceNotificationItem {
  id: number;
  event_type: NotificationEventType;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  invoice_id: string | null;
  run_id: string | null;
  actor_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  is_read: boolean;
  read_at: string | null;
  invoice_number: string | null;
  original_filename: string | null;
  processing_status: string | null;
  business_decision: string | null;
  review_status: string | null;
  primary_reason_code: string | null;
  total_amount: string | null;
  currency: string | null;
  vendor_name: string | null;
}

export interface NotificationsResponse {
  items: WorkspaceNotificationItem[];
  unread_count: number;
  pending_review_count: number;
  failed_count: number;
  enabled_types: NotificationEventType[];
}

export function useWorkspaceNotifications(userId: string | undefined, userRole?: string) {
  const queryClient = useQueryClient();
  const [toasts, setToasts] = useState<WorkspaceNotificationItem[]>([]);
  const [streamConnected, setStreamConnected] = useState(false);
  const seenToastIdsRef = useRef<Set<number>>(new Set());
  const toastTimersRef = useRef<Map<number, number>>(new Map());

  const queryKey = ['notifications', userId ?? 'anon'] as const;

  const { data } = useQuery({
    queryKey,
    queryFn: () => apiFetch<NotificationsResponse>('/notifications?limit=30'),
    refetchInterval: streamConnected ? 60_000 : 15_000,
    enabled: Boolean(userId),
  });

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (item: WorkspaceNotificationItem) => {
      if (seenToastIdsRef.current.has(item.id)) return;
      seenToastIdsRef.current.add(item.id);
      setToasts((prev) => [item, ...prev.filter((t) => t.id !== item.id)].slice(0, 3));
      const timer = window.setTimeout(() => {
        dismissToast(item.id);
      }, 7500);
      toastTimersRef.current.set(item.id, timer);
    },
    [dismissToast]
  );

  useEffect(() => {
    if (!userId) return;

    const roleQuery = getDemoAuthQueryString();

    const es = new EventSource(`/api/v1/notifications/stream${roleQuery}`, {
      withCredentials: true,
    });

    const handleCreated = (ev: MessageEvent) => {
      try {
        const item = JSON.parse(ev.data) as WorkspaceNotificationItem;
        setStreamConnected(true);
        queryClient.setQueryData<NotificationsResponse>(queryKey, (prev) => {
          if (!prev) return prev;
          if (prev.items.some((existing) => existing.id === item.id)) {
            return prev;
          }
          const nextPending =
            item.event_type === 'MANUAL_REVIEW_REQUIRED'
              ? prev.pending_review_count + 1
              : item.event_type === 'REVIEW_RESOLVED'
                ? Math.max(0, prev.pending_review_count - 1)
                : prev.pending_review_count;

          return {
            ...prev,
            items: [{ ...item, is_read: false, read_at: null }, ...prev.items].slice(0, 30),
            unread_count: prev.unread_count + 1,
            pending_review_count: nextPending,
          };
        });

        pushToast(item);
        void queryClient.invalidateQueries({ queryKey: ['invoices'] });
        void queryClient.invalidateQueries({ queryKey: ['reviews'] });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
      } catch {
        // ignore malformed SSE frame
      }
    };

    const handleSync = () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };

    es.onopen = () => setStreamConnected(true);
    es.addEventListener('notification_created', handleCreated);
    es.addEventListener('notifications_sync', handleSync);
    es.onerror = () => setStreamConnected(false);

    return () => {
      setStreamConnected(false);
      es.close();
    };
  }, [userId, userRole, queryClient, pushToast]);

  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  const markReadMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/notifications/${id}/read`, { method: 'POST', body: '{}' }),
    onMutate: (id) => {
      queryClient.setQueryData<NotificationsResponse>(queryKey, (prev) => {
        if (!prev) return prev;
        let decremented = 0;
        const nextItems = prev.items.map((item) => {
          if (item.id === id && !item.is_read) {
            decremented = 1;
            return { ...item, is_read: true, read_at: new Date().toISOString() };
          }
          return item;
        });
        return {
          ...prev,
          items: nextItems,
          unread_count: Math.max(0, prev.unread_count - decremented),
        };
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => apiFetch('/notifications/read-all', { method: 'POST', body: '{}' }),
    onMutate: () => {
      const now = new Date().toISOString();
      queryClient.setQueryData<NotificationsResponse>(queryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((item) => ({ ...item, is_read: true, read_at: item.read_at || now })),
          unread_count: 0,
        };
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  return {
    items: data?.items ?? [],
    unreadCount: data?.unread_count ?? 0,
    pendingReviewCount: data?.pending_review_count ?? 0,
    streamConnected,
    toasts,
    dismissToast,
    markRead: (id: number) => markReadMutation.mutate(id),
    markAllRead: () => markAllReadMutation.mutate(),
    markingAll: markAllReadMutation.isPending,
  };
}
