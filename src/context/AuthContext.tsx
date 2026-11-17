import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, DEMO_ROLE_STORAGE_KEY, type UserProfile, type UserRole } from '../lib/api';

interface AuthContextValue {
  user: UserProfile | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchDemoRole: (role: UserRole) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const me = await apiFetch<UserProfile>('/auth/me');
      setUser(me);
    } catch {
      try {
        const boot = await apiFetch<UserProfile>('/auth/demo-bootstrap', { method: 'POST' });
        setUser(boot);
      } catch {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    const loggedIn = await apiFetch<UserProfile>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem(DEMO_ROLE_STORAGE_KEY, loggedIn.role);
    setUser(loggedIn);
    queryClient.clear();
  };

  const logout = async () => {
    const res = await apiFetch<{ ok: boolean; auth_paused?: boolean }>('/auth/logout', { method: 'POST' });
    if (res.auth_paused) {
      await refreshUser();
      return;
    }
    localStorage.removeItem(DEMO_ROLE_STORAGE_KEY);
    setUser(null);
    queryClient.clear();
  };

  const switchDemoRole = async (role: UserRole) => {
    localStorage.setItem(DEMO_ROLE_STORAGE_KEY, role);
    const switched = await apiFetch<UserProfile>('/auth/demo-switch', {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
    setUser(switched);
    queryClient.removeQueries({ queryKey: ['audit-logs'] });
    queryClient.removeQueries({ queryKey: ['admin-users'] });
    await queryClient.invalidateQueries();
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, switchDemoRole, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
