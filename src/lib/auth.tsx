import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Permission } from '@shared/permissions';

export interface SessionUser {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  pricing_category_id: string;
  roles: string[];
  permissions: Permission[];
}

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** Whether the signed-in user holds a platform permission (UI hint only; the API enforces it). */
  can: (permission: Permission) => boolean;
  refresh: () => Promise<void>;
  setUser: (u: SessionUser | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<SessionUser>('/me');
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  const roles = user?.roles ?? [];
  const permissions = user?.permissions ?? [];
  const value: AuthContextValue = {
    user,
    loading,
    isAdmin: roles.length > 0,
    isSuperAdmin: roles.includes('super_admin'),
    can: (permission) => permissions.includes(permission),
    refresh,
    setUser,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
